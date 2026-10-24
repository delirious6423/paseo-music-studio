// Fixture host for "@getpaseo/plugin/client": the real SDK runtime plus the two host-injected functions.
// useSettings mirrors packages/app/src/plugins/settings/use-settings.ts (Paseo ab6cdb7) over the same settings
// RPCs, with plain useQuery instead of the app's push-synced replica query. Test harness only; not shipped.
import type { SettingsDefinition } from "@getpaseo/plugin";
import { settingsRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { z, type ZodType } from "zod";
import { useRpc } from "../../node_modules/@getpaseo/plugin/dist/client/index.js";
export * from "../../node_modules/@getpaseo/plugin/dist/client/index.js";

export async function openExternalUrl(url: string) {
  (globalThis as { openedUrls?: string[] }).openedUrls?.push(url);
}

export function useSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>): any {
  const rpc = useMemo(() => settingsRpc(definition.id), [definition.id]);
  const read = useRpc(rpc.read), write = useRpc(rpc.write);
  const client = useQueryClient();
  const key = ["plugin-settings", definition.id];
  const query = useQuery({ queryKey: key, queryFn: () => read({}), retry: false });
  const mutation = useMutation({
    mutationFn: async (input: { revision: string; values: z.output<Schema> }) => {
      const result = await write({ revision: input.revision, values: z.json().parse(await definition.schema.parseAsync(input.values)) });
      if (result.status !== "saved") throw new Error(result.error);
      client.setQueryData(key, { ...result, status: "ready" });
    },
  });
  const actions = {
    saving: mutation.isPending,
    saveError: mutation.error ? String(mutation.error) : null,
    save: async (values: z.output<Schema>, revision: string) => mutation.mutateAsync({ values, revision }).then(() => true, () => false),
    reset: async () => false,
    reload: async () => { mutation.reset(); await query.refetch(); },
  };
  if (query.isPending) return { ...actions, status: "loading" };
  if (query.isError) return { ...actions, status: "error", error: String(query.error) };
  if (query.data.status === "invalid") return { ...actions, ...query.data };
  const parsed = definition.schema.safeParse(query.data.values);
  if (!parsed.success) return { ...actions, status: "invalid", revision: query.data.revision, error: parsed.error.message };
  return { ...actions, ...query.data, values: parsed.data };
}
