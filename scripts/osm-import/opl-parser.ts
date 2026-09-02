import type { Coordinate } from "./peak-matcher.ts";

export type OsmTags = Record<string, string>;

export interface OplNode {
  type: "node";
  id: number;
  tags: OsmTags;
  coordinate: Coordinate | null;
}

export interface OplWayNode {
  nodeId: number;
  coordinate: Coordinate | null;
}

export interface OplWay {
  type: "way";
  id: number;
  tags: OsmTags;
  nodes: OplWayNode[];
}

export interface OplRelationMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}

export interface OplRelation {
  type: "relation";
  id: number;
  tags: OsmTags;
  members: OplRelationMember[];
}

export type OplObject = OplNode | OplWay | OplRelation;

export function decodeOplText(value: string): string {
  return value.replace(/%([0-9a-fA-F]{1,6})%/g, (_match, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

function parseTags(value: string): OsmTags {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    value.split(",").map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        return [decodeOplText(entry), ""];
      }
      return [
        decodeOplText(entry.slice(0, separator)),
        decodeOplText(entry.slice(separator + 1)),
      ];
    }),
  );
}

function parseWayNodes(value: string): OplWayNode[] {
  if (!value) {
    return [];
  }

  return value.split(",").map((entry) => {
    const match = /^n(-?\d+)(?:x(-?\d+(?:\.\d+)?)y(-?\d+(?:\.\d+)?))?$/.exec(
      entry,
    );
    if (!match) {
      throw new Error(`Malformed OPL way node: ${entry}`);
    }

    return {
      nodeId: Number(match[1]),
      coordinate:
        match[2] !== undefined && match[3] !== undefined
          ? [Number(match[2]), Number(match[3])]
          : null,
    };
  });
}

function parseMembers(value: string): OplRelationMember[] {
  if (!value) {
    return [];
  }

  return value.split(",").map((entry) => {
    const match = /^([nwr])(-?\d+)@(.*)$/.exec(entry);
    if (!match) {
      throw new Error(`Malformed OPL relation member: ${entry}`);
    }

    const type =
      match[1] === "n" ? "node" : match[1] === "w" ? "way" : "relation";
    return {
      type,
      ref: Number(match[2]),
      role: decodeOplText(match[3]),
    };
  });
}

export function parseOplLine(line: string): OplObject {
  const fields = line.trimEnd().split(" ");
  const identity = fields[0];
  const objectType = identity[0];
  const id = Number(identity.slice(1));

  if (!Number.isSafeInteger(id) || !["n", "w", "r"].includes(objectType)) {
    throw new Error(`Malformed OPL object identity: ${identity}`);
  }

  const values = new Map<string, string>();
  for (const field of fields.slice(1)) {
    if (field) {
      values.set(field[0], field.slice(1));
    }
  }
  const tags = parseTags(values.get("T") ?? "");

  if (objectType === "n") {
    const longitude = values.get("x");
    const latitude = values.get("y");
    return {
      type: "node",
      id,
      tags,
      coordinate:
        longitude !== undefined && latitude !== undefined
          ? [Number(longitude), Number(latitude)]
          : null,
    };
  }

  if (objectType === "w") {
    return {
      type: "way",
      id,
      tags,
      nodes: parseWayNodes(values.get("N") ?? ""),
    };
  }

  return {
    type: "relation",
    id,
    tags,
    members: parseMembers(values.get("M") ?? ""),
  };
}
