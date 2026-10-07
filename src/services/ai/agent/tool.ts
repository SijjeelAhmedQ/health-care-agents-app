/**
 * The tool contract. A tool is a name, a description the model reads, a zod
 * schema for its arguments and the code that runs it. The JSON Schema the
 * model sees is generated from the zod schema, and the model's arguments are
 * validated against the same schema before anything runs — invalid arguments
 * go back to the model as an error it can correct.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolResult } from '@/types/ai';
import type { ToolSchema } from '../providers/llm';
import type { AppRuntime } from './runtime';

export interface ToolContext {
  runtime: AppRuntime;
}

/** How a tool is written: its arguments typed from its schema. */
export interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: S;
  /** A short "what I'm doing" line for the assistant panel while the tool runs. */
  progress?: (args: z.infer<S>) => string;
  /** Mends the shape of what a model sent (one item outside its list, JSON as text) before it is checked. */
  normalize?: (raw: Record<string, unknown>) => Record<string, unknown>;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** A tool as the agent holds it. Its arguments are only ever produced by `parseArgs` with its own schema. */
export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  progress?: (args: unknown) => string;
  normalize?: (raw: Record<string, unknown>) => Record<string, unknown>;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodTypeAny>(spec: ToolSpec<S>): Tool {
  return spec as unknown as Tool;
}

/** Tools that take no arguments. */
export const noArgs = z.object({});

/** The JSON Schema of a tool's parameters, inlined (small models cope badly with $ref). */
export function toToolSchema(tool: Tool): ToolSchema {
  const schema = compact(zodToJsonSchema(tool.parameters, { $refStrategy: 'none', target: 'openApi3' })) as Record<string, unknown>;
  delete schema.$schema;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: schema } };
}

/**
 * Drop what tells the model nothing (`additionalProperties: false` on every object): every token of
 * the schemas is re-read on a cold start, and arguments are validated against the zod schema anyway.
 */
function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact);
  if (node && typeof node === 'object') {
    const out = Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k, v]) => !(k === 'additionalProperties' && v === false)).map(([k, v]) => [k, compact(v)]));
    // OpenAPI 3 writes a strict bound as `minimum: 0, exclusiveMinimum: true`; OpenAI (and JSON Schema
    // today) want the bound itself — `exclusiveMinimum: 0` — and refuse every request otherwise.
    for (const [flag, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
      if (typeof out[flag] !== 'boolean') continue;
      if (out[flag] && typeof out[bound] === 'number') {
        out[flag] = out[bound];
        delete out[bound];
      } else delete out[flag];
    }
    return out;
  }
  return node;
}

/** Models sometimes send `null` for an argument they mean to leave out. */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
  }
  return value;
}

export type ParsedArgs = { ok: true; args: unknown } | { ok: false; error: string };

export function parseArgs(tool: Tool, raw: Record<string, unknown>): ParsedArgs {
  const result = tool.parameters.safeParse(dropNulls(tool.normalize ? tool.normalize(raw) : raw));
  if (result.success) return { ok: true, args: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
  return { ok: false, error: `Invalid arguments for ${tool.name} — ${issues}` };
}
