import { describe, it, expect } from "vitest";
import {
  normalizeResponsesInput,
  convertResponsesApiFormat,
} from "../../open-sse/translator/formats/responsesApi.js";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { openaiToCursorRequest } from "../../open-sse/translator/request/openai-to-cursor.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";

describe("normalizeResponsesInput & convertResponsesApiFormat — agent_message handling", () => {
  it("returns the input array reference unchanged when no agent_message items exist", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ];
    expect(normalizeResponsesInput(input)).toBe(input);
  });

  it("normalizes Multi-Agents V2 agent_message items without mutating caller objects", () => {
    const rawAgentItem = {
      type: "agent_message",
      role: "agent",
      author: "explorer-1",
      recipient: "coordinator",
      internal_chat_message_metadata_passthrough: { trace_id: "abc" },
      content: [{ type: "input_text", text: "Subagent findings" }],
    };
    const missingRoleItem = {
      type: "AGENT_MESSAGE",
      author: "worker-2",
      content: "Completed task",
    };
    const devRoleItem = {
      type: "agent_message",
      role: "developer",
      recipient: "worker-2",
      content: [{ type: "input_text", text: "Follow repo conventions" }],
    };
    const assistantRoleItem = {
      type: "agent_message",
      role: "assistant",
      content: [{ type: "output_text", text: "Prior agent reply" }],
    };

    const originalSnapshot = JSON.parse(
      JSON.stringify([rawAgentItem, missingRoleItem, devRoleItem, assistantRoleItem]),
    );

    const normalized = normalizeResponsesInput([
      rawAgentItem,
      missingRoleItem,
      devRoleItem,
      assistantRoleItem,
    ]);

    // Caller objects must not be mutated
    expect([rawAgentItem, missingRoleItem, devRoleItem, assistantRoleItem]).toEqual(originalSnapshot);

    expect(normalized).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Subagent findings" }],
      },
      {
        type: "message",
        role: "user",
        content: "Completed task",
      },
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "Follow repo conventions" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Prior agent reply" }],
      },
    ]);
  });

  it("convertResponsesApiFormat converts agent_message and role='agent' message items", () => {
    const out = convertResponsesApiFormat({
      instructions: "System base",
      input: [
        {
          type: "agent_message",
          role: "agent",
          content: [{ type: "input_text", text: "From subagent" }],
        },
        {
          type: "message",
          role: "agent",
          content: "Direct agent role message",
        },
        {
          type: "message",
          content: "Missing role message",
        },
      ],
    });

    expect(out.messages).toEqual([
      { role: "system", content: "System base" },
      { role: "user", content: [{ type: "text", text: "From subagent" }] },
      { role: "user", content: "Direct agent role message" },
      { role: "user", content: "Missing role message" },
    ]);
  });
});

describe("openaiResponsesToOpenAIRequest & openaiToOpenAIResponsesRequest", () => {
  it("openaiResponsesToOpenAIRequest converts agent_message items and attaches reasoning only to assistant", () => {
    const body = {
      instructions: "Top-level instructions",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Developer prompt" }],
        },
        {
          type: "agent_message",
          role: "agent",
          author: "subagent-1",
          content: [{ type: "input_text", text: "Subagent report" }],
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking step" }],
          encrypted_content: "enc_blob_1",
        },
        {
          type: "agent_message",
          role: "assistant",
          content: [{ type: "output_text", text: "Assistant response" }],
        },
      ],
    };

    const out = openaiResponsesToOpenAIRequest("gpt-5.4", body, true);
    expect(out.messages).toEqual([
      { role: "system", content: "Top-level instructions" },
      { role: "developer", content: [{ type: "text", text: "Developer prompt" }] },
      { role: "user", content: [{ type: "text", text: "Subagent report" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Assistant response" }],
        reasoning_content: "Thinking step",
        encrypted_content: "enc_blob_1",
      },
    ]);
  });

  it("openaiToOpenAIResponsesRequest concatenates all system and developer messages into instructions", () => {
    const body = {
      messages: [
        { role: "system", content: "System rule 1" },
        {
          role: "developer",
          content: [
            { type: "text", text: "Developer rule 2" },
            { type: "text", text: "Developer rule 3" },
          ],
        },
        { role: "user", content: "Hello" },
        { role: "developer", content: "Mid-turn developer instruction" },
      ],
    };

    const out = openaiToOpenAIResponsesRequest("gpt-5.4", body, true);
    expect(out.instructions).toBe(
      "System rule 1\n\nDeveloper rule 2\nDeveloper rule 3\n\nMid-turn developer instruction",
    );
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    ]);
  });

  it("openaiToOpenAIResponsesRequest handles empty leading system message followed by developer message", () => {
    const body = {
      messages: [
        { role: "system", content: "" },
        { role: "developer", content: "Non-empty developer instruction" },
        { role: "user", content: "Hi" },
      ],
    };

    const out = openaiToOpenAIResponsesRequest("gpt-5.4", body, true);
    expect(out.instructions).toBe("Non-empty developer instruction");
  });

  it("openaiToOpenAIResponsesRequest normalizes agent_message items when body.input is already present", () => {
    const rawAgentItem = {
      type: "agent_message",
      role: "Agent",
      author: "subagent-1",
      recipient: "coordinator",
      internal_chat_message_metadata_passthrough: { hop: 1 },
      content: [{ type: "input_text", text: "Subagent payload" }],
    };
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5.4",
      { input: [rawAgentItem], max_tokens: 512 },
      true,
    );

    expect(out.max_output_tokens).toBe(512);
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Subagent payload" }],
      },
    ]);
    expect(rawAgentItem.type).toBe("agent_message");
  });

  it("openaiResponsesToOpenAIRequest normalizes mixed-case roles and attaches reasoning to Assistant", () => {
    const out = openaiResponsesToOpenAIRequest(
      "gpt-5.4",
      {
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Mixed-case reasoning" }],
          },
          {
            type: "agent_message",
            role: "Assistant",
            content: [{ type: "output_text", text: "Mixed-case assistant" }],
          },
        ],
      },
      true,
    );

    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Mixed-case assistant" }],
        reasoning_content: "Mixed-case reasoning",
      },
    ]);
  });
});

describe("downstream translators — role='developer' support", () => {
  it("openaiToGeminiRequest merges multiple system and developer messages into systemInstruction", () => {
    const out = openaiToGeminiRequest(
      "gemini-2.5-pro",
      {
        messages: [
          { role: "system", content: "System prompt" },
          { role: "developer", content: [{ type: "text", text: "Developer prompt" }] },
          { role: "user", content: "User question" },
        ],
      },
      true,
    );

    expect(out.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "System prompt" }, { text: "Developer prompt" }],
    });
    expect(out.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "User question" }],
      },
    ]);
  });

  it("openaiToGeminiRequest falls back to user contents when only developer/system messages exist", () => {
    const out = openaiToGeminiRequest(
      "gemini-2.5-pro",
      {
        messages: [
          { role: "developer", content: "Only developer prompt" },
        ],
      },
      true,
    );

    expect(out.systemInstruction).toBeUndefined();
    expect(out.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Only developer prompt" }],
      },
    ]);
  });

  it("openaiToClaudeRequest extracts developer messages into system blocks and excludes them from messages", () => {
    const out = openaiToClaudeRequest(
      "claude-sonnet-4-6",
      {
        messages: [
          { role: "system", content: "System prompt" },
          { role: "developer", content: [{ type: "text", text: "Developer prompt" }] },
          { role: "user", content: "Ask Claude" },
        ],
      },
      true,
    );

    const sysTexts = out.system.map((b) => b.text);
    expect(sysTexts).toContain("System prompt\nDeveloper prompt");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("normalizeClaudePassthrough folds leading and mid-conversation developer messages into user turns without mutating caller", () => {
    const devLead = { role: "developer", content: "Leading dev directive" };
    const userTurn = { role: "user", content: "Hello" };
    const devMid = { role: "developer", content: [{ type: "text", text: "Mid-turn dev reminder" }] };
    const assistantTurn = { role: "assistant", content: [{ type: "text", text: "Reply" }] };
    const devTail = { role: "developer", content: "Post-assistant dev note" };

    const body = {
      messages: [devLead, userTurn, devMid, assistantTurn, devTail],
    };

    const out = normalizeClaudePassthrough(body, "claude-sonnet-4-6");
    expect(out.messages.some((m) => m.role === "developer" || m.role === "system")).toBe(false);
    // devLead becomes user turn, then userTurn and devMid fold into user turns
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Leading dev directive" }],
    });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "Mid-turn dev reminder" },
      ],
    });
    expect(out.messages[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Reply" }],
    });
    expect(out.messages[3]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Post-assistant dev note" }],
    });
    // Original userTurn must not have been mutated in place
    expect(userTurn.content).toBe("Hello");
  });

  it("openaiToCursorRequest converts developer messages into [System Instructions] user turns", () => {
    const out = openaiToCursorRequest(
      "claude-4-sonnet",
      {
        messages: [
          { role: "developer", content: "Follow strict typing" },
          { role: "user", content: "Write function" },
        ],
      },
      true,
    );

    expect(out.messages).toEqual([
      { role: "user", content: "[System Instructions]\nFollow strict typing" },
      { role: "user", content: "Write function" },
    ]);
  });

  it("openaiToKiroRequest folds developer messages into user input alongside system messages", () => {
    const out = openaiToKiroRequest(
      "claude-sonnet-4.5",
      {
        messages: [
          { role: "system", content: "System context" },
          { role: "developer", content: "Developer instructions" },
          { role: "user", content: "User task" },
        ],
      },
      true,
    );

    const currentContent = out.conversationState.currentMessage.userInputMessage.content;
    expect(currentContent).toContain("System context");
    expect(currentContent).toContain("Developer instructions");
    expect(currentContent).toContain("User task");
  });

  it("openaiToCommandCodeRequest extracts developer messages into params.system", () => {
    const out = openaiToCommandCodeRequest(
      "claude-sonnet-4.5",
      {
        messages: [
          { role: "system", content: "Sys A" },
          { role: "developer", content: [{ type: "text", text: "Dev B" }] },
          { role: "user", content: "User C" },
        ],
      },
      true,
    );

    expect(out.params.system).toBe("Sys A\n\nDev B");
    expect(out.params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "User C" }],
      },
    ]);
  });

  it("openaiToOllamaRequest normalizes developer role to system role", () => {
    const out = openaiToOllamaRequest(
      "qwen3",
      {
        messages: [
          { role: "developer", content: "Be concise" },
          { role: "user", content: "Hi" },
        ],
      },
      true,
    );

    expect(out.messages).toEqual([
      { role: "system", content: "Be concise" },
      { role: "user", content: "Hi" },
    ]);
  });

  it("preserves both instructions and developer/agent_message items across multi-hop Responses -> OpenAI -> Gemini/Claude/Responses", () => {
    const responsesPayload = {
      instructions: "Base system instructions",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Subagent role instructions" }],
        },
        {
          type: "agent_message",
          role: "agent",
          author: "coordinator",
          recipient: "explorer",
          content: [{ type: "input_text", text: "Inspect translator files" }],
        },
      ],
    };

    const chatBody = openaiResponsesToOpenAIRequest(
      "gemini-2.5-pro",
      structuredClone(responsesPayload),
      true,
    );

    const geminiOut = openaiToGeminiRequest("gemini-2.5-pro", structuredClone(chatBody), true);
    expect(geminiOut.systemInstruction).toEqual({
      role: "user",
      parts: [
        { text: "Base system instructions" },
        { text: "Subagent role instructions" },
      ],
    });
    expect(geminiOut.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Inspect translator files" }],
      },
    ]);

    const claudeOut = openaiToClaudeRequest("claude-sonnet-4-6", structuredClone(chatBody), true);
    expect(claudeOut.system.map((b) => b.text)).toContain(
      "Base system instructions\nSubagent role instructions",
    );
    expect(claudeOut.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Inspect translator files" }],
      },
    ]);

    const responsesRoundtrip = openaiToOpenAIResponsesRequest(
      "gpt-5.4",
      structuredClone(chatBody),
      true,
    );
    expect(responsesRoundtrip.instructions).toBe(
      "Base system instructions\n\nSubagent role instructions",
    );
    expect(responsesRoundtrip.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect translator files" }],
      },
    ]);
  });
});
