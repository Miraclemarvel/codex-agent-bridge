import { z } from "zod";
export const modelSelectionSchema = z
  .object({
    provider: z.string().trim().min(1).max(160),
    model: z.string().trim().min(1).max(300),
    reasoningEffort: z.string().trim().min(1).max(40).optional(),
    credentialRef: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ModelBinding = {
  revision: number;
  selection: ModelSelection | null;
};
export type CatalogModel = {
  id: string;
  name: string;
  reasoningEfforts: string[];
};
export type CatalogProvider = {
  id: string;
  name: string;
  available: boolean;
  models: CatalogModel[];
};
export type ModelCatalog = {
  providers: CatalogProvider[];
  credentialRefs: string[];
  fetchedAt: string;
  source: string;
};
