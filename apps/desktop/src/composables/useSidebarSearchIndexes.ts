import { onScopeDispose, ref, shallowRef, watch, type Ref, type WatchSource } from "vue";
import type { SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";

export function useSidebarSearchIndexes(options: { query: Ref<string>; context: WatchSource[]; load: (shouldCancel: () => boolean) => Promise<SidebarRegexIndexScope[]>; onError: (error: unknown) => void }) {
  const scopes = shallowRef<SidebarRegexIndexScope[]>([]);
  const isLoading = ref(false);
  let generation = 0;

  watch([() => !!options.query.value, ...options.context], () => {
    const currentGeneration = ++generation;
    scopes.value = [];
    isLoading.value = !!options.query.value;
    if (!isLoading.value) return;
    const shouldCancel = () => currentGeneration !== generation || !options.query.value;
    void options
      .load(shouldCancel)
      .then((loaded) => {
        if (!shouldCancel()) scopes.value = loaded;
      })
      .catch((error) => {
        if (!shouldCancel()) options.onError(error);
      })
      .finally(() => {
        if (currentGeneration === generation) isLoading.value = false;
      });
  });

  onScopeDispose(() => {
    generation += 1;
  });

  return { scopes, isLoading };
}
