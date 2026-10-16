// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReceiverMock
 * @notice Simulates a destination-chain contract that receives cross-chain
 *         payloads forwarded by the Smart Listener executor.
 *
 *         In production this would be replaced by a real on-chain or Fabric
 *         smart contract. This mock is labelled SIMULATED intentionally.
 *
 * @dev Only the designated executor (set at deploy time) can call `execute`.
 *      Duplicate execution is prevented by the `executed` mapping.
 */
contract ReceiverMock {
    // ── Events ────────────────────────────────────────────────────────────────

    event CrossChainExecuted(
        bytes32 indexed sourceTxId,
        address indexed executor,
        bytes   payload,
        uint256 timestamp
    );

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Trusted executor address (the Smart Listener API / executor module)
    address public immutable executor;

    /// @notice sourceTxId → executed (replay / duplicate guard)
    mapping(bytes32 => bool) public executed;

    /// @notice In-order list of executed tx IDs for easy enumeration
    bytes32[] public executionHistory;

    // ── Errors ────────────────────────────────────────────────────────────────

    error NotExecutor();
    error AlreadyExecuted();
    error EmptyPayload();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _executor) {
        executor = _executor;
    }

    // ── External ──────────────────────────────────────────────────────────────

    /**
     * @notice Execute a cross-chain payload forwarded by the Smart Listener.
     * @param sourceTxId  The txId from the source SenderContract event
     * @param payload     The original payload bytes
     */
    function execute(bytes32 sourceTxId, bytes calldata payload) external {
        if (msg.sender != executor) revert NotExecutor();
        if (executed[sourceTxId])  revert AlreadyExecuted();
        if (payload.length == 0)   revert EmptyPayload();

        executed[sourceTxId] = true;
        executionHistory.push(sourceTxId);

        emit CrossChainExecuted(sourceTxId, msg.sender, payload, block.timestamp);
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function getExecutionCount() external view returns (uint256) {
        return executionHistory.length;
    }

    function wasExecuted(bytes32 txId) external view returns (bool) {
        return executed[txId];
    }
}
