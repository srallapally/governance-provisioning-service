/**
 * The vocabulary of a durable operation row.
 *
 * These lived in the framework's `spi/types.ts` until CP-5 moved them here
 * with the dispatcher. They describe a row's lifecycle, and only the claim
 * loop has rows -- a connector returns or throws, and never reaches a terminal
 * status. Keeping them in core would have made its type surface imply a queue
 * that package does not own.
 */

/**
 * Terminal result of an operation.
 *
 * The three failures are deliberately distinct because the remedy differs:
 * REJECTED_PRE_DISPATCH never reached the target and is safe to retry
 * wholesale, FAILED_CONFIRMED will refuse again until the input changes, and
 * INDETERMINATE can only be settled by reconciliation.
 */
export type OperationOutcome =
    | "SUCCEEDED"
    | "REJECTED_PRE_DISPATCH"
    | "FAILED_CONFIRMED"
    | "INDETERMINATE";

/**
 * The non-terminal states.
 *
 * AWAITING_READBACK is a create whose attempt timed out and which is waiting
 * to be read back by naming attribute. It exists so that wait can happen
 * without holding a mutation slot, a lane, and a connector lease (BUG-1).
 */
export type OperationPendingStatus = "PENDING" | "RUNNING" | "AWAITING_READBACK";

/**
 * Lifecycle status of a durable operation row: the non-terminal states plus
 * every {@link OperationOutcome}. A row is terminal exactly when its status is
 * an OperationOutcome, which is the condition the partition drop gate and the
 * finalize guard both test.
 */
export type OperationStatus = OperationPendingStatus | OperationOutcome;
