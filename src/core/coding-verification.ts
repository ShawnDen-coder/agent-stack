import { z } from "zod";

export const codingVerificationSchema = z.strictObject({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.literal("isolated-pi-tui-herdr-socket-v1"),
});
export type CodingVerification = z.infer<typeof codingVerificationSchema>;
