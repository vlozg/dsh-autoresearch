/**
 * Architecture conformance — the machine-checked half of docs/ARCHITECTURE.md.
 *
 * Runs on every `pnpm test`: walks src/ with the TypeScript parser and
 * asserts the import graph against the layering rules. A failing rule here
 * is an architecture review comment you get for free at test time.
 *
 *   Host (hexagonal):  dependencies point INWARD
 *     root → infra → adapters → app → domain → shared wire
 *   Client (FSD):      imports point DOWNWARD
 *     app(index) → features → entities → shared
 *
 * Rules table lives in this file — change the architecture, change the table
 * (and docs/ARCHITECTURE.md) in the same commit.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const GATEWAY = "src/client/shared/wire.ts"; // the only file allowed to cross into src/shared from the client

// ---------------------------------------------------------------------------
// Layer classification
// ---------------------------------------------------------------------------

function layerOf(abs: string): string {
  let rel = path.relative(SRC, abs).split(path.sep).join("/");
  // Directory/barrel imports resolve to their index file (e.g. ./adapters).
  if (!/\.tsx?$/.test(rel) && fs.existsSync(path.join(SRC, rel, "index.ts"))) rel += "/index.ts";
  if (rel === "host/index.ts") return "host:root";
  if (rel === "client/index.ts") return "client:root";
  if (rel.startsWith("shared/")) return "shared";
  if (rel.startsWith("host/domain/")) return "host:domain";
  if (rel.startsWith("host/app/")) return "host:app";
  if (rel.startsWith("host/adapters/")) return "host:adapters";
  if (rel.startsWith("host/infra/")) return "host:infra";
  if (rel.startsWith("host/")) return "host:root";
  if (rel.startsWith("client/shared/")) return "client:shared";
  if (rel.startsWith("client/entities/")) return "client:entities";
  if (rel.startsWith("client/features/")) return "client:features";
  if (rel.startsWith("client/")) return "client:root";
  throw new Error(`unclassified src file: ${rel}`);
}

// Which internal layers each layer may import. Everything not listed is a violation.
const TARGETS: Record<string, readonly string[]> = {
  // hexagonal: inward only. root = composition root (wiring, may see everything)
  "host:domain": ["host:domain", "shared"],
  "host:app": ["host:app", "host:domain", "shared"],
  "host:adapters": ["host:adapters", "host:app", "host:domain", "shared"],
  "host:infra": ["host:infra", "host:app", "host:domain", "shared"],
  "host:root": ["host:domain", "host:app", "host:adapters", "host:infra", "shared"],
  // FSD: downward only. app(index) → features → entities → shared
  "client:shared": ["client:shared", "shared"], // shared/wire.ts is the sanctioned gateway into the wire contract
  "client:entities": ["client:entities", "client:shared"],
  "client:features": ["client:features", "client:entities", "client:shared"],
  "client:root": ["client:features"],
  // the wire contract imports nothing
  "shared": [],
};

// Bare-specifier policy per layer. "value" = any import form; "type" = `import type` only; null = forbidden.
const BARE: Record<string, Partial<Record<"node" | "dsh" | "react" | "other", "value" | "type">>> = {
  "shared": {},
  "host:domain": {}, // pure: no node builtins, no framework, nothing
  "host:app": { node: "value", dsh: "type" }, // node path/util OK; framework types are the accepted seam
  "host:adapters": { node: "value" },
  "host:infra": { node: "value", dsh: "value" }, // driving edge: may hold the framework
  "host:root": { node: "value", dsh: "value" },
  "client:shared": { react: "value" },
  "client:entities": { react: "value" },
  "client:features": { react: "value", dsh: "type" }, // platform modules enter type-only via the feature entry
  "client:root": {},
};

// ---------------------------------------------------------------------------
// Import-edge extraction (AST, so comments and strings never false-positive)
// ---------------------------------------------------------------------------

interface Edge {
  file: string; // repo-relative
  layer: string;
  spec: string;
  line: number;
  targetLayer: string | null; // resolved for relative specs, null for bare
  bareKind: "node" | "dsh" | "react" | "other" | null;
  typeOnly: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(abs);
  }
  return out;
}

function bareKindOf(spec: string): Edge["bareKind"] {
  if (spec.startsWith("node:")) return "node";
  if (spec === "react" || spec.startsWith("react/")) return "react";
  if (spec.startsWith("@deepseek-ai/")) return "dsh";
  return "other";
}

function collectEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const abs of walk(SRC)) {
    const text = fs.readFileSync(abs, "utf8");
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true);
    const layer = layerOf(abs);
    for (const stmt of sf.statements) {
      let spec: string | null = null;
      let typeOnly = false;
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        spec = stmt.moduleSpecifier.text;
        typeOnly = stmt.importClause?.isTypeOnly ?? false;
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        spec = stmt.moduleSpecifier.text;
        typeOnly = stmt.isTypeOnly;
      }
      if (spec === null) continue;
      let targetLayer: string | null = null;
      if (spec.startsWith(".")) targetLayer = layerOf(path.resolve(path.dirname(abs), spec));
      const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
      edges.push({
        file: path.relative(ROOT, abs),
        layer,
        spec,
        line,
        targetLayer,
        bareKind: targetLayer === null ? bareKindOf(spec) : null,
        typeOnly,
      });
    }
  }
  return edges;
}

const EDGES = collectEdges();

function checkEdges(edges: Edge[]): string[] {
  const bad: string[] = [];
  for (const e of edges) {
    const at = `${e.file}:${e.line}`;
    if (e.targetLayer !== null) {
      if (!(TARGETS[e.layer] ?? []).includes(e.targetLayer)) {
        bad.push(`${at}: ${e.layer} may not import ${e.targetLayer} ("${e.spec}") — see TARGETS in tests/architecture.test.ts`);
        continue;
      }
      // The wire contract is type-only everywhere: it never ships runtime code.
      if (e.targetLayer === "shared" && !e.typeOnly) {
        bad.push(`${at}: imports of the wire contract must be 'import type' ("${e.spec}")`);
      }
      // Client touches src/shared only through the shared-layer gateway.
      if (e.layer.startsWith("client:") && e.targetLayer === "shared" && e.file !== GATEWAY) {
        bad.push(`${at}: client code must import the wire via ${GATEWAY}, not directly ("${e.spec}")`);
      }
    } else {
      const policy = BARE[e.layer]?.[e.bareKind!];
      if (policy === undefined) {
        bad.push(`${at}: ${e.layer} may not import bare module "${e.spec}" — see BARE in tests/architecture.test.ts`);
      } else if (policy === "type" && !e.typeOnly) {
        bad.push(`${at}: "${e.spec}" is only allowed as a type-only import in ${e.layer}`);
      }
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe("architecture conformance", () => {
  it("scans a populated src tree (guards against a vacuous pass)", () => {
    expect(walk(SRC).length).toBeGreaterThan(25);
    expect(EDGES.length).toBeGreaterThan(50);
  });

  it("host hexagon: dependencies point inward (root → infra → adapters → app → domain)", () => {
    const bad = checkEdges(EDGES.filter((e) => e.layer.startsWith("host:")));
    expect(bad).toEqual([]);
  });

  it("client FSD: imports point downward (features → entities → shared)", () => {
    const bad = checkEdges(EDGES.filter((e) => e.layer.startsWith("client:")));
    expect(bad).toEqual([]);
  });

  it("the shared wire imports nothing (standalone contract)", () => {
    const bad = checkEdges(EDGES.filter((e) => e.layer === "shared"));
    expect(bad).toEqual([]);
    // type-only by construction: every shared import anywhere is checked in checkEdges
  });

  it("domain layer stays pure: no node builtins, no framework, no process/require globals", () => {
    const bad = checkEdges(EDGES.filter((e) => e.layer === "host:domain"));
    expect(bad).toEqual([]);
    for (const abs of walk(SRC)) {
      if (layerOf(abs) !== "host:domain") continue;
      const text = fs.readFileSync(abs, "utf8");
      const rel = path.relative(ROOT, abs);
      expect(text.includes("process.")).toBe(false); // no implicit env access
      expect(text.includes("require(")).toBe(false);
      expect(text.includes("Buffer")).toBe(false);
    }
  });

  it("cross-face isolation: host and client never import each other", () => {
    const cross = EDGES.filter((e) =>
      (e.layer.startsWith("host:") && e.targetLayer?.startsWith("client:")) ||
      (e.layer.startsWith("client:") && e.targetLayer?.startsWith("host:")),
    );
    expect(cross.map((e) => `${e.file}:${e.line} → ${e.spec}`)).toEqual([]);
  });
});
