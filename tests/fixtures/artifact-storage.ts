import { createArtifactStore } from "../../src/features/artifact-storage/store";
import type {
  ArtifactCollectionDefinition,
  HostArtifactCollection,
} from "../../src/features/artifact-storage/types";
const stores: ReturnType<typeof createArtifactStore>[] = [];
const definition: ArtifactCollectionDefinition = {
  name: "tasks",
  type: "test.task",
  version: 1,
  project({ record, preference }) {
    const data = record.current
      ? JSON.parse(record.current.content)
      : record.local;
    const prefs = preference as
      | { archived?: boolean; pinned?: boolean }
      | undefined;
    const value = prefs?.archived ?? data?.archived ?? false;
    return [
      { index: "archive", value: String(value), order: record.id },
      { index: "pin", value: String(prefs?.pinned ?? false), order: record.id },
    ];
  },
};
const api = {
  open(
    viewer = "viewer",
    relay = "relay",
    owner = "test",
    overrides: Partial<ArtifactCollectionDefinition> = {},
  ) {
    const store = createArtifactStore(viewer, relay);
    stores.push(store);
    return store.collection(owner, { ...definition, ...overrides });
  },
  close() {
    for (const store of stores) store.close();
  },
};
declare global {
  interface Window {
    artifactTest: typeof api;
    collection: HostArtifactCollection;
    change: Promise<unknown>;
  }
}
window.artifactTest = api;
