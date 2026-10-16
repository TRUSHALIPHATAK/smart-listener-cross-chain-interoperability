/**
 * fabricAdapter.ts — Hyperledger Fabric destination adapter (STUB)
 *
 * This is a modular stub. Enable via DESTINATION_TYPE=fabric.
 * Requires the @hyperledger/fabric-gateway npm package and a running Fabric network.
 *
 * To activate:
 *   1. Install Fabric Gateway SDK: npm install @hyperledger/fabric-gateway
 *   2. Set DESTINATION_TYPE=fabric in .env
 *   3. Set FABRIC_CHANNEL, FABRIC_CHAINCODE, FABRIC_MSP_ID, FABRIC_WALLET_PATH,
 *      FABRIC_GATEWAY_URL in .env
 *   4. Implement the actual Gateway connection and chaincode invoke below.
 */

import { DestinationResult, CrossChainTransaction } from "../types";
import { childLogger } from "../logger";
import { FABRIC_CHANNEL, FABRIC_CHAINCODE, FABRIC_GATEWAY_URL } from "../config";

const log = childLogger("fabricAdapter");

/**
 * Execute a cross-chain transaction via Hyperledger Fabric chaincode.
 *
 * [STUB] This function currently throws — it serves as the integration point
 * for real Fabric implementation without cluttering the dev path.
 */
export async function fabricExecute(
  tx: CrossChainTransaction
): Promise<DestinationResult> {
  log.warn(
    { txId: tx.txId, channel: FABRIC_CHANNEL, chaincode: FABRIC_CHAINCODE, gateway: FABRIC_GATEWAY_URL },
    "[FABRIC STUB] Fabric adapter is not yet implemented. Set DESTINATION_TYPE=simulated for development."
  );

  // TODO: Replace stub with real implementation:
  //
  // import * as grpc from "@grpc/grpc-js";
  // import { connect, Contract, Identity, Signer, signers } from "@hyperledger/fabric-gateway";
  // import * as crypto from "crypto";
  // import * as fs from "fs";
  //
  // const client = await newGrpcConnection();
  // const gateway = connect({ client, identity, signer });
  // const network  = gateway.getNetwork(FABRIC_CHANNEL);
  // const contract = network.getContract(FABRIC_CHAINCODE);
  // await contract.submitTransaction("ExecuteCrossChain", tx.txId, tx.payload);
  // gateway.close();
  // client.close();

  return {
    success: false,
    errorMessage: "[FABRIC STUB] Fabric adapter not implemented. See fabricAdapter.ts for integration instructions.",
  };
}
