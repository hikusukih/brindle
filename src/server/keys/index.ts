// The key manager's one entry point. Nothing outside this directory imports anything else from it (see biome.json).

export { type SecretKind, type SecretScope, VaultError } from "./scope.js";
export { handleFor, minSecretLength, openVault, type SecretInfo, type StoreInput, Vault } from "./vault.js";
