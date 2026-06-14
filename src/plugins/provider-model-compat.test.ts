import { describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";
import { resolveAssistantTextDelivery } from "./provider-model-compat.js";

function modelRef(
  provider: string,
  id: string,
  assistantTextDelivery?: "live" | "terminal_only",
): Pick<Model, "provider" | "id" | "compat"> {
  return {
    provider,
    id,
    compat: assistantTextDelivery ? { assistantTextDelivery } : undefined,
  } as Pick<Model, "provider" | "id" | "compat">;
}

describe("resolveAssistantTextDelivery", () => {
  it("defaults only zai/glm-5.2 to terminal_only", () => {
    expect(resolveAssistantTextDelivery(modelRef("zai", "glm-5.2"))).toBe("terminal_only");
    expect(resolveAssistantTextDelivery(modelRef("zai", "glm-5"))).toBe("live");
    expect(resolveAssistantTextDelivery(modelRef("other", "glm-5.2"))).toBe("live");
  });

  it("honors an explicit model compat override", () => {
    expect(resolveAssistantTextDelivery(modelRef("zai", "glm-5.2", "live"))).toBe("live");
    expect(resolveAssistantTextDelivery(modelRef("other", "model", "terminal_only"))).toBe(
      "terminal_only",
    );
  });
});
