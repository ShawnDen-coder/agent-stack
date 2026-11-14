import { z } from "zod";

// Shapes are shared; each consumer chooses stripping or strict-object semantics.
export const npmSourceShape = {
  type: z.literal("npm"),
  registry: z.literal("https://registry.npmjs.org"),
  package: z.string(),
};
export const releaseSourceShape = {
  type: z.literal("github-release"),
  owner: z.literal("astral-sh"),
  repo: z.literal("uv"),
  releaseId: z.number().int().positive(),
  tag: z.string(),
};
export const channelSourceShape = {
  type: z.literal("channel-manifest"),
  manifest: z.literal("https://herdr.dev/latest.json"),
  channel: z.literal("stable"),
  version: z.string(),
};
export const definitionDigestsShape = {
  algorithm: z.literal("sha256-canonical-json-v1"),
  profile: z.string(),
  components: z.record(z.string(), z.string()),
  integrations: z.record(z.string(), z.string()),
};
