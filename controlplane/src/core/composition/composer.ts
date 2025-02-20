import { randomUUID } from 'node:crypto';
import { JsonValue } from '@bufbuild/protobuf';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { FederationResult, FederationResultContainerWithContracts, FieldConfiguration } from '@wundergraph/composition';
import { ComposedSubgraph, buildRouterConfig } from '@wundergraph/cosmo-shared';
import { FastifyBaseLogger } from 'fastify';
import { DocumentNode, parse, printSchema } from 'graphql';
import { FederatedGraphDTO, Label, SubgraphDTO } from '../../types/index.js';
import { BlobStorage } from '../blobstorage/index.js';
import { audiences, nowInSeconds, signJwtHS256 } from '../crypto/jwt.js';
import { ContractRepository } from '../repositories/ContractRepository.js';
import { FederatedGraphRepository } from '../repositories/FederatedGraphRepository.js';
import { SubgraphRepository } from '../repositories/SubgraphRepository.js';
import {
  AdmissionError,
  AdmissionWebhookController,
  AdmissionWebhookJwtPayload,
} from '../services/AdmissionWebhookController.js';
import { composeSubgraphs, composeSubgraphsWithContracts } from './composition.js';
import { GetDiffBetweenGraphsResult, getDiffBetweenGraphs } from './schemaCheck.js';

export type CompositionResult = {
  compositions: ComposedFederatedGraph[];
};

export interface S3RouterConfigMetadata extends Record<string, string> {
  version: string;
  'signature-sha256': string;
}

export function subgraphDTOsToComposedSubgraphs(
  subgraphs: SubgraphDTO[],
  result?: FederationResult,
): ComposedSubgraph[] {
  return subgraphs.map((subgraph) => {
    /* batchNormalize returns an intermediate representation of the engine configuration
     *  and a normalized schema per subgraph.
     *  Batch normalization is necessary because validation of certain things such as the @override directive requires
     *  knowledge of the other subgraphs.
     *  Each normalized schema and engine configuration is mapped by subgraph name to a SubgraphConfig object wrapper.
     *  This is passed to the FederationFactory and is returned by federateSubgraphs if federation is successful.
     *  The normalized schema and engine configuration is used by buildRouterConfig.
     * */
    const subgraphConfig = result?.subgraphConfigBySubgraphName.get(subgraph.name);
    const schema = subgraphConfig?.schema;
    const configurationDataMap = subgraphConfig?.configurationDataMap;
    return {
      id: subgraph.id,
      name: subgraph.name,
      url: subgraph.routingUrl,
      sdl: subgraph.schemaSDL,
      schemaVersionId: subgraph.schemaVersionId,
      subscriptionUrl: subgraph.subscriptionUrl,
      subscriptionProtocol: subgraph.subscriptionProtocol,
      configurationDataMap,
      schema,
    };
  });
}

export function mapResultToComposedGraph(
  federatedGraph: FederatedGraphDTO,
  subgraphs: SubgraphDTO[],
  errors?: Error[],
  result?: FederationResult,
): ComposedFederatedGraph {
  return {
    id: federatedGraph.id,
    targetID: federatedGraph.targetId,
    name: federatedGraph.name,
    namespace: federatedGraph.namespace,
    namespaceId: federatedGraph.namespaceId,
    composedSchema: result?.federatedGraphSchema ? printSchemaWithDirectives(result.federatedGraphSchema) : undefined,
    federatedClientSchema: result?.federatedGraphClientSchema
      ? printSchema(result.federatedGraphClientSchema)
      : undefined,
    shouldIncludeClientSchema: result?.shouldIncludeClientSchema || false,
    errors: errors || [],
    subgraphs: subgraphDTOsToComposedSubgraphs(subgraphs, result),
    fieldConfigurations: result?.fieldConfigurations || [],
  };
}

export interface ComposedFederatedGraph {
  id: string;
  targetID: string;
  name: string;
  namespace: string;
  namespaceId: string;
  composedSchema?: string;
  errors: Error[];
  subgraphs: ComposedSubgraph[];
  fieldConfigurations: FieldConfiguration[];
  federatedClientSchema?: string;
  shouldIncludeClientSchema?: boolean;
}

export interface CompositionDeployResult {
  errors: ComposeDeploymentError[];
}

export class RouterConfigUploadError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    Object.setPrototypeOf(this, RouterConfigUploadError.prototype);
  }
}

export type ComposeDeploymentError = RouterConfigUploadError | AdmissionError | Error;

export class Composer {
  constructor(
    private logger: FastifyBaseLogger,
    private federatedGraphRepo: FederatedGraphRepository,
    private subgraphRepo: SubgraphRepository,
    private contractRepo: ContractRepository,
  ) {}

  /**
   * Build and store the final router config and federated schema to the database as well as to the CDN. A diff between the
   * previous and current schema is stored as changelog.
   */
  async deployComposition({
    composedGraph,
    composedBy,
    blobStorage,
    organizationId,
    admissionConfig,
    admissionWebhookURL,
  }: {
    composedGraph: ComposedFederatedGraph;
    composedBy: string;
    blobStorage: BlobStorage;
    organizationId: string;
    admissionWebhookURL?: string;
    admissionConfig: {
      jwtSecret: string;
      cdnBaseUrl: string;
    };
  }): Promise<CompositionDeployResult> {
    const hasCompositionErrors = composedGraph.errors.length > 0;
    const federatedSchemaVersionId = randomUUID();

    let routerConfigJson: JsonValue = null;

    // CDN path and bucket path are the same in this case
    const s3PathDraft = `${organizationId}/${composedGraph.id}/routerconfigs/draft.json`;
    const s3PathReady = `${organizationId}/${composedGraph.id}/routerconfigs/latest.json`;

    // The signature will be added by the admission webhook
    let signatureSha256: undefined | string;

    // It is important to use undefined here, we do not null check in the database queries
    let deploymentError: RouterConfigUploadError | undefined;
    let admissionError: AdmissionError | undefined;

    // Build and deploy the router config when composed schema is valid
    if (!hasCompositionErrors && composedGraph.composedSchema) {
      const federatedClientSDL = composedGraph.shouldIncludeClientSchema
        ? composedGraph.federatedClientSchema || ''
        : '';
      const routerConfig = buildRouterConfig({
        federatedClientSDL,
        federatedSDL: composedGraph.composedSchema,
        fieldConfigurations: composedGraph.fieldConfigurations,
        subgraphs: composedGraph.subgraphs,
        schemaVersionId: federatedSchemaVersionId,
      });
      routerConfigJson = routerConfig.toJson();
      const routerConfigJsonStringBytes = Buffer.from(routerConfig.toJsonString(), 'utf8');

      if (admissionWebhookURL) {
        try {
          // 1. Upload the draft config to the blob storage
          // so that the admission webhook can download it.
          await blobStorage.putObject<S3RouterConfigMetadata>({
            key: s3PathDraft,
            body: routerConfigJsonStringBytes,
            contentType: 'application/json; charset=utf-8',
            metadata: {
              version: federatedSchemaVersionId,
              'signature-sha256': '', // The signature will be added by the admission webhook
            },
          });

          try {
            // 2. Create a private URL with a token that the admission webhook can use to fetch the draft config.
            // The token is valid for 5 minutes and signed with the organization ID and the federated graph ID.
            const token = await signJwtHS256<AdmissionWebhookJwtPayload>({
              secret: admissionConfig.jwtSecret,
              token: {
                iat: nowInSeconds() + 5 * 60, // 5 minutes
                aud: audiences.cosmoCDNAdmission, // to distinguish from other tokens
                organization_id: organizationId,
                federated_graph_id: composedGraph.id,
              },
            });

            const admissionWebhookController = new AdmissionWebhookController(this.logger, admissionWebhookURL);

            const resp = await admissionWebhookController.validateConfig({
              privateConfigUrl: `${admissionConfig.cdnBaseUrl}/${s3PathDraft}?token=${token}`,
              organizationId,
              federatedGraphId: composedGraph.id,
            });

            signatureSha256 = resp.signatureSha256;
          } finally {
            // Always clean up the draft config after the draft has been validated.
            await blobStorage.deleteObject({
              key: s3PathDraft,
            });
          }
        } catch (err: any) {
          this.logger.debug(
            {
              error: err,
              federatedGraphId: composedGraph.id,
            },
            `Admission webhook failed to validate the router config for the federated graph.`,
          );

          if (err instanceof AdmissionError) {
            admissionError = err;
          } else {
            admissionError = new AdmissionError('Admission webhook failed to validate the router config', err);
          }
        }
      }

      // Deploy the final router config to the blob storage if the admission webhook did not fail
      if (!admissionError) {
        try {
          await blobStorage.putObject<S3RouterConfigMetadata>({
            key: s3PathReady,
            body: routerConfigJsonStringBytes,
            contentType: 'application/json; charset=utf-8',
            metadata: {
              version: federatedSchemaVersionId,
              'signature-sha256': signatureSha256 || '',
            },
          });
        } catch (err: any) {
          this.logger.debug(
            {
              error: err,
              federatedGraphId: composedGraph.id,
            },
            'Failed to upload the final router config to the blob storage',
          );
          deploymentError = new RouterConfigUploadError('Failed to upload the final router config to the CDN', err);
        }
      }
    }

    const prevValidFederatedSDL = await this.federatedGraphRepo.getLatestValidSchemaVersion({
      targetId: composedGraph.targetID,
    });

    const updatedFederatedGraph = await this.federatedGraphRepo.addSchemaVersion({
      targetId: composedGraph.targetID,
      composedSDL: composedGraph.composedSchema,
      clientSchema: composedGraph.federatedClientSchema,
      subgraphSchemaVersionIds: composedGraph.subgraphs.map((s) => s.schemaVersionId!),
      compositionErrors: composedGraph.errors,
      routerConfig: routerConfigJson,
      routerConfigSignature: signatureSha256,
      deploymentError,
      admissionError,
      composedBy,
      schemaVersionId: federatedSchemaVersionId,
      // passing the path only when there exists a previous valid version or when the composition passes.
      routerConfigPath:
        prevValidFederatedSDL || (!hasCompositionErrors && composedGraph.composedSchema) ? s3PathReady : null,
    });

    // Only create changelog when the composed schema is valid
    if (
      !hasCompositionErrors &&
      (composedGraph.composedSchema || composedGraph.federatedClientSchema) &&
      updatedFederatedGraph?.composedSchemaVersionId
    ) {
      let schemaChanges: GetDiffBetweenGraphsResult;

      // Prioritize diff against client schemas if no previous valid schema available or if both prev and current client schema is available.
      if (
        (composedGraph.federatedClientSchema && !prevValidFederatedSDL) ||
        (composedGraph.federatedClientSchema && prevValidFederatedSDL?.clientSchema)
      ) {
        schemaChanges = await getDiffBetweenGraphs(
          prevValidFederatedSDL?.clientSchema || '',
          composedGraph.federatedClientSchema,
        );
      } else {
        // Fallback to full schema for backwards compatibility
        schemaChanges = await getDiffBetweenGraphs(prevValidFederatedSDL?.schema || '', composedGraph.composedSchema);
      }

      if (schemaChanges.kind !== 'failure' && schemaChanges.changes.length > 0) {
        await this.federatedGraphRepo.createFederatedGraphChangelog({
          schemaVersionID: updatedFederatedGraph.composedSchemaVersionId,
          changes: schemaChanges.changes,
        });
      }
    }

    const errors: ComposeDeploymentError[] = [];

    if (deploymentError) {
      errors.push(deploymentError);
    }

    if (admissionError) {
      errors.push(admissionError);
    }

    return {
      errors,
    };
  }

  /**
   * Composes all subgraphs of a federated graph into a single federated graph.
   * Optionally, you can pass extra subgraphs to include them in the composition.
   */
  async composeFederatedGraph(federatedGraph: FederatedGraphDTO): Promise<ComposedFederatedGraph> {
    const subgraphs = await this.subgraphRepo.listByFederatedGraph({
      federatedGraphTargetId: federatedGraph.targetId,
      published: true,
    });
    try {
      // A federated graph must have at least one subgraph. Let the composition fail if there are none.

      const { errors, federationResult: result } = composeSubgraphs(
        subgraphs.map((s) => ({
          name: s.name,
          url: s.routingUrl,
          definitions: parse(s.schemaSDL),
        })),
      );

      return mapResultToComposedGraph(federatedGraph, subgraphs, errors, result);
    } catch (e: any) {
      return {
        id: federatedGraph.id,
        name: federatedGraph.name,
        namespace: federatedGraph.namespace,
        namespaceId: federatedGraph.namespaceId,
        targetID: federatedGraph.targetId,
        fieldConfigurations: [],
        errors: [e],
        subgraphs: subgraphs.map((subgraph) => {
          return {
            id: subgraph.id,
            name: subgraph.name,
            url: subgraph.routingUrl,
            sdl: subgraph.schemaSDL,
            schemaVersionId: subgraph.schemaVersionId,
            subscriptionUrl: subgraph.subscriptionUrl,
            subscriptionProtocol: subgraph.subscriptionProtocol,
          };
        }),
      };
    }
  }

  protected async composeWithLabels(
    subgraphLabels: Label[],
    namespaceId: string,
    mapSubgraphs: (
      subgraphs: SubgraphDTO[],
    ) => [SubgraphDTO[], { name: string; url: string; definitions: DocumentNode }[]],
  ): Promise<CompositionResult> {
    const composedGraphs: ComposedFederatedGraph[] = [];
    let federationResultContainer: FederationResultContainerWithContracts;

    const graphs = await this.federatedGraphRepo.bySubgraphLabels({
      labels: subgraphLabels,
      namespaceId,
      excludeContracts: true,
    });

    for await (const graph of graphs) {
      try {
        const [subgraphs, subgraphsToBeComposed] = mapSubgraphs(
          await this.subgraphRepo.listByFederatedGraph({ federatedGraphTargetId: graph.targetId }),
        );

        const contracts = await this.contractRepo.bySourceFederatedGraphId(graph.id);

        if (contracts.length > 0) {
          const tagExclusionsByContractName: Map<string, Set<string>> = new Map();

          for (const contract of contracts) {
            tagExclusionsByContractName.set(
              contract.downstreamFederatedGraph.target.name,
              new Set(contract.excludeTags),
            );
          }

          federationResultContainer = composeSubgraphsWithContracts(subgraphsToBeComposed, tagExclusionsByContractName);
        } else {
          federationResultContainer = composeSubgraphs(subgraphsToBeComposed);
        }

        if (!federationResultContainer) {
          throw new Error('Could not federate subgraphs');
        }

        const { federationResult: result, errors, federationResultContainerByContractName } = federationResultContainer;

        composedGraphs.push(mapResultToComposedGraph(graph, subgraphs, errors, result));

        if (federationResultContainerByContractName) {
          for (const [contractName, contractResultContainer] of federationResultContainerByContractName.entries()) {
            const { errors: contractErrors, federationResult: contractResult } = contractResultContainer;

            const contractGraph = await this.federatedGraphRepo.byName(contractName, graph.namespace);
            if (!contractGraph) {
              throw new Error(`Contract graph ${contractName} not found`);
            }

            composedGraphs.push(mapResultToComposedGraph(contractGraph, subgraphs, contractErrors, contractResult));
          }
        }
      } catch (e: any) {
        composedGraphs.push({
          id: graph.id,
          name: graph.name,
          namespace: graph.namespace,
          namespaceId: graph.namespaceId,
          targetID: graph.targetId,
          fieldConfigurations: [],
          errors: [e],
          subgraphs: [],
        });
      }
    }

    return {
      compositions: composedGraphs,
    };
  }

  /**
   * Same as compose, but the proposed schemaSDL of the subgraph is not updated to the table, so it is passed to the function
   */
  composeWithProposedSDL(
    subgraphLabels: Label[],
    subgraphName: string,
    namespaceId: string,
    subgraphSchemaSDL: string,
  ) {
    return this.composeWithLabels(subgraphLabels, namespaceId, (subgraphs) => {
      const subgraphsToBeComposed = [];

      for (const subgraph of subgraphs) {
        if (subgraph.name === subgraphName) {
          subgraphsToBeComposed.push({
            name: subgraph.name,
            url: subgraph.routingUrl,
            definitions: parse(subgraphSchemaSDL),
          });
        } else if (subgraph.schemaSDL !== '') {
          subgraphsToBeComposed.push({
            name: subgraph.name,
            url: subgraph.routingUrl,
            definitions: parse(subgraph.schemaSDL),
          });
        }
      }

      return [subgraphs, subgraphsToBeComposed];
    });
  }

  composeWithDeletedSubgraph(subgraphLabels: Label[], subgraphName: string, namespaceId: string) {
    return this.composeWithLabels(subgraphLabels, namespaceId, (subgraphs) => {
      const subgraphsToBeComposed = [];

      const filteredSubgraphs = subgraphs.filter((s) => s.name !== subgraphName);

      for (const subgraph of subgraphs) {
        if (subgraph.name !== subgraphName && subgraph.schemaSDL !== '') {
          subgraphsToBeComposed.push({
            name: subgraph.name,
            url: subgraph.routingUrl,
            definitions: parse(subgraph.schemaSDL),
          });
        }
      }

      return [filteredSubgraphs, subgraphsToBeComposed];
    });
  }
}
