/// <reference types="vite/client" />

import type { EthereumProvider } from "./sepolia";

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export {};