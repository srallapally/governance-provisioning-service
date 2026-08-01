import { runOperationStoreContract } from "./operation-store.contract.js";
import { MemoryOperationStore } from "../harness/MemoryOperationStore.js";

// The in-memory store runs the contract unconditionally: it is what the
// dispatcher tests execute against, so it is the implementation most at risk
// of quietly diverging from the real one.
runOperationStoreContract("MemoryOperationStore", () => {
  const store = new MemoryOperationStore();
  return {
    store,
    expireHotRow: (id: string) => store.expireHotRow(id),
  };
});
