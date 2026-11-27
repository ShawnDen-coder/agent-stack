// Add the shared agent to Pi's already assembled prompt, including user context.
import { readFile } from "node:fs/promises";

export default function (pi: {
  on: (
    name: "before_agent_start",
    handler: (event: {
      systemPrompt: string;
    }) => Promise<{ systemPrompt: string } | undefined>,
  ) => void;
}) {
  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    const agent = await readFile(
      new URL("../../../agents/coding.md", import.meta.url),
      "utf8",
    );
    if (event.systemPrompt.includes(agent.trim())) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${agent}` };
  });
}
