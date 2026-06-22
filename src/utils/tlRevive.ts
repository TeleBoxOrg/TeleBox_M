// TL 对象序列化/还原工具 — mtcute 原生版
// mtcute 的 TL 对象是带 _ 字段的普通对象,不需要 class 构造函数。
// 序列化时 _ 字段已自动保留,还原时只需递归处理 Buffer 和嵌套对象。

type JsonLike = unknown;

function isBufferLike(v: unknown): v is { type: "Buffer"; data: number[] } {
  return (
    v != null && typeof v === "object" && "type" in v && "data" in v &&
    (v as { type: unknown }).type === "Buffer" && Array.isArray((v as { data: unknown }).data)
  );
}

export function reviveTl<T = any>(input: JsonLike): T {
  // Arrays
  if (Array.isArray(input)) {
    // @ts-ignore
    return input.map((i) => reviveTl(i));
  }
  // Buffers serialized by JSON
  if (isBufferLike(input)) {
    // @ts-ignore
    return Buffer.from(input.data);
  }
  // Primitive
  if (!input || typeof input !== "object") {
    // @ts-ignore
    return input;
  }

  // mtcute TL objects are plain objects with _ field.
  // No constructor resolution needed — just recursively revive nested properties.
  const revived: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    revived[k] = reviveTl(v);
  }

  // @ts-ignore
  return revived as T;
}

import { tl } from "@mtcute/core";

/** Revive message entities from JSON — returns mtcute tl.TypeMessageEntity[] */
export function reviveEntities(
  jsonEntities: JsonLike
): tl.TypeMessageEntity[] | undefined {
  if (!jsonEntities) return undefined;
  const entities = reviveTl<tl.TypeMessageEntity[]>(jsonEntities);
  return entities;
}

/** Revive message media from JSON — returns mtcute tl.TypeMessageMedia or undefined */
export function reviveMedia(
  jsonMedia: JsonLike
): tl.TypeMessageMedia | undefined {
  if (!jsonMedia) return undefined;
  const media = reviveTl<tl.TypeMessageMedia>(jsonMedia);
  // Filter out media types that cannot be resent via sendFile
  if (
    media?._ === "messageMediaWebPage" ||
    media?._ === "messageMediaEmpty" ||
    media?._ === "messageMediaUnsupported"
  ) {
    return undefined;
  }
  return media;
}