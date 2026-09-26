// Release sealing: the canonical content hash Qwibi recomputes on publication,
// the derived release id and the App's current release. A developer seals and
// publishes a release with these helpers and copies no server code.
import { clone, ScalarType, type DescField } from "@bufbuild/protobuf";
import { reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { AppReleaseSchema, type AppRelease } from "./gen/qwibi/v1/app_release_pb.js";
import type { ListAppReleasesResponse } from "./gen/qwibi/v1/app_release_service_pb.js";
import { SortOrder } from "./gen/qwibi/v1/common_pb.js";

/**
 * The UUIDv5 namespace of {@link releaseIdFor}. It never changes; the Go SDK
 * uses the same bytes (qwibi.ReleaseIDNamespace), so both derive the same id.
 */
export const RELEASE_ID_NAMESPACE = "3b1f6c0e-9452-4d7a-a82e-51c907d36f18";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const IMPLICIT_PRESENCE = 2;

/**
 * canonicalReleaseBytes is the byte string Qwibi hashes: the deterministic
 * protobuf encoding (as Go's `proto.MarshalOptions{Deterministic: true}`) of
 * the release without its release id, App id, semantic version, content hash,
 * publication time and top-level unknown fields.
 *
 * `toBinary` is not canonical: it writes map entries in JavaScript object order
 * (integer-like keys first) and drops a negative zero, so its hash differs from
 * the server's for any release with a Struct or a localization table.
 */
export function canonicalReleaseBytes(release: AppRelease): Uint8Array {
  const projection = clone(AppReleaseSchema, release);
  projection.releaseId = "";
  projection.appId = "";
  projection.semanticVersion = "";
  projection.canonicalContentSha256 = new Uint8Array(0);
  projection.publishedAt = undefined;
  projection.$unknown = undefined;
  return writeMessage(new BinaryWriter(), reflect(AppReleaseSchema, projection)).finish();
}

/**
 * releaseContentSha256 is the canonical content hash Qwibi recomputes when a
 * release is published. Two releases with the same hash declare the same thing.
 */
export async function releaseContentSha256(release: AppRelease): Promise<Uint8Array> {
  const bytes = canonicalReleaseBytes(release);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/**
 * releaseIdFor derives the release id of one version of one App: the UUIDv5
 * (RFC 9562) of "<appId>/<semanticVersion>" under {@link RELEASE_ID_NAMESPACE}.
 * A derived id keeps a repeated publication of the same version identical to
 * the first, so Qwibi replays it instead of refusing a second release.
 */
export async function releaseIdFor(appId: string, semanticVersion: string): Promise<string> {
  const namespace = hexBytes(RELEASE_ID_NAMESPACE.replaceAll("-", ""));
  const name = new TextEncoder().encode(`${appId}/${semanticVersion}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const sum = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", input));
  const u = sum.slice(0, 16);
  u[6] = (u[6]! & 0x0f) | 0x50;
  u[8] = (u[8]! & 0x3f) | 0x80;
  const hex = [...u].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * sealRelease returns a copy of the release ready to publish: its App id is
 * `appId`, its release id is {@link releaseIdFor} unless one is already set,
 * and its canonical content hash is filled in. The input is not modified.
 * `publishedAt` must be set, to microsecond precision, and later than the
 * App's current release; keep it fixed per version so a repeat is replayed.
 */
export async function sealRelease(appId: string, release: AppRelease): Promise<AppRelease> {
  if (!LOWER_UUID.test(appId)) throw new Error(`App id "${appId}" is not a lower-case UUID`);
  if (!release.semanticVersion) throw new Error("release has no semantic version");
  const at = release.publishedAt;
  if (!at) throw new Error("release publishedAt must be a valid timestamp");
  if (at.nanos % 1000 !== 0) throw new Error("release publishedAt precision must not exceed one microsecond");
  const sealed = clone(AppReleaseSchema, release);
  sealed.appId = appId;
  if (!sealed.releaseId) sealed.releaseId = await releaseIdFor(appId, sealed.semanticVersion);
  sealed.canonicalContentSha256 = await releaseContentSha256(sealed);
  return sealed;
}

/**
 * laterRelease reports whether `a` was published after `b`: by publication
 * time, then by release id. Any release is later than undefined.
 */
export function laterRelease(a: AppRelease | undefined, b: AppRelease | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const as = a.publishedAt?.seconds ?? 0n;
  const bs = b.publishedAt?.seconds ?? 0n;
  if (as !== bs) return as > bs;
  const an = a.publishedAt?.nanos ?? 0;
  const bn = b.publishedAt?.nanos ?? 0;
  if (an !== bn) return an > bn;
  return a.releaseId > b.releaseId;
}

/** The part of a client that {@link currentAppRelease} needs. */
export interface AppReleaseLister {
  listAppReleases(request: {
    appId: string;
    page?: { limit: number; cursor: string; order: SortOrder };
  }): Promise<ListAppReleasesResponse>;
}

/**
 * currentAppRelease returns the App's current release: the latest publication
 * by publication time and then release id, as Qwibi orders every new
 * publication (publishing a release makes it current in every installation
 * at once). It walks every page and returns undefined when the
 * App has no release.
 */
export async function currentAppRelease(client: AppReleaseLister, appId: string): Promise<AppRelease | undefined> {
  let current: AppRelease | undefined;
  const seen = new Set<string>();
  let cursor = "";
  for (;;) {
    const response = await client.listAppReleases({
      appId,
      page: { limit: 1000, cursor, order: SortOrder.UNSPECIFIED },
    });
    for (const release of response.releases) {
      if (laterRelease(release, current)) current = release;
    }
    const next = response.page?.nextCursor ?? "";
    if (!next) return current;
    if (seen.has(next)) throw new Error(`page cursor "${next}" repeated`);
    seen.add(next);
    cursor = next;
  }
}

// --- deterministic encoder -------------------------------------------------

function writeMessage(writer: BinaryWriter, message: ReflectMessage): BinaryWriter {
  for (const field of message.sortedFields) {
    if (!isSetCanonically(message, field)) continue;
    writeField(writer, message, field);
  }
  for (const { no, wireType, data } of message.getUnknown() ?? []) {
    writer.tag(no, wireType).raw(data);
  }
  return writer;
}

// Go writes an implicit-presence float or double whose bits are not zero, so
// a negative zero is written; protobuf-es treats it as unset.
function isSetCanonically(message: ReflectMessage, field: DescField): boolean {
  if (message.isSet(field)) return true;
  if (field.fieldKind !== "scalar" || field.presence !== IMPLICIT_PRESENCE) return false;
  if (field.scalar !== ScalarType.DOUBLE && field.scalar !== ScalarType.FLOAT) return false;
  return Object.is(message.get(field), -0);
}

function writeField(writer: BinaryWriter, message: ReflectMessage, field: DescField): void {
  switch (field.fieldKind) {
    case "scalar":
    case "enum":
      writeScalar(writer, field.fieldKind === "enum" ? ScalarType.INT32 : field.scalar, field.number, message.get(field));
      return;
    case "message": {
      const value = message.get(field) as ReflectMessage;
      if (field.delimitedEncoding) {
        writeMessage(writer.tag(field.number, WireType.StartGroup), value).tag(field.number, WireType.EndGroup);
      } else {
        writeMessage(writer.tag(field.number, WireType.LengthDelimited).fork(), value).join();
      }
      return;
    }
    case "list": {
      const items = [...(message.get(field) as Iterable<unknown>)];
      if (field.listKind === "message") {
        for (const item of items) {
          if (field.delimitedEncoding) {
            writeMessage(writer.tag(field.number, WireType.StartGroup), item as ReflectMessage).tag(field.number, WireType.EndGroup);
          } else {
            writeMessage(writer.tag(field.number, WireType.LengthDelimited).fork(), item as ReflectMessage).join();
          }
        }
        return;
      }
      const scalar = field.listKind === "enum" ? ScalarType.INT32 : field.scalar;
      if (field.packed) {
        if (items.length === 0) return;
        writer.tag(field.number, WireType.LengthDelimited).fork();
        for (const item of items) writeScalarValue(writer, scalar, item);
        writer.join();
        return;
      }
      for (const item of items) writeScalar(writer, scalar, field.number, item);
      return;
    }
    case "map": {
      const entries = [...(message.get(field) as ReadonlyMap<unknown, unknown>)];
      entries.sort((a, b) => compareMapKeys(field.mapKey, a[0], b[0]));
      for (const [key, value] of entries) {
        writer.tag(field.number, WireType.LengthDelimited).fork();
        writeScalar(writer, field.mapKey, 1, key);
        switch (field.mapKind) {
          case "scalar":
          case "enum":
            writeScalar(writer, field.mapKind === "enum" ? ScalarType.INT32 : field.scalar, 2, value);
            break;
          case "message":
            writeMessage(writer.tag(2, WireType.LengthDelimited).fork(), value as ReflectMessage).join();
            break;
        }
        writer.join();
      }
      return;
    }
  }
}

// Go sorts map keys bytewise for strings, numerically for integers and false
// before true for booleans.
function compareMapKeys(type: ScalarType, a: unknown, b: unknown): number {
  if (type === ScalarType.STRING) return compareBytes(utf8(a as string), utf8(b as string));
  if (type === ScalarType.BOOL) return Number(a) - Number(b);
  const x = BigInt(a as string | number | bigint);
  const y = BigInt(b as string | number | bigint);
  return x < y ? -1 : x > y ? 1 : 0;
}

const encoder = new TextEncoder();
function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function writeScalar(writer: BinaryWriter, type: ScalarType, number: number, value: unknown): void {
  writeScalarValue(writer.tag(number, wireTypeOf(type)), type, value);
}

function writeScalarValue(writer: BinaryWriter, type: ScalarType, value: unknown): void {
  switch (type) {
    case ScalarType.STRING: writer.string(value as string); break;
    case ScalarType.BOOL: writer.bool(value as boolean); break;
    case ScalarType.DOUBLE: writer.double(value as number); break;
    case ScalarType.FLOAT: writer.float(value as number); break;
    case ScalarType.INT32: writer.int32(value as number); break;
    case ScalarType.INT64: writer.int64(value as bigint | string); break;
    case ScalarType.UINT64: writer.uint64(value as bigint | string); break;
    case ScalarType.FIXED64: writer.fixed64(value as bigint | string); break;
    case ScalarType.BYTES: writer.bytes(value as Uint8Array); break;
    case ScalarType.FIXED32: writer.fixed32(value as number); break;
    case ScalarType.SFIXED32: writer.sfixed32(value as number); break;
    case ScalarType.SFIXED64: writer.sfixed64(value as bigint | string); break;
    case ScalarType.SINT64: writer.sint64(value as bigint | string); break;
    case ScalarType.UINT32: writer.uint32(value as number); break;
    case ScalarType.SINT32: writer.sint32(value as number); break;
  }
}

function wireTypeOf(type: ScalarType): WireType {
  switch (type) {
    case ScalarType.BYTES:
    case ScalarType.STRING:
      return WireType.LengthDelimited;
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return WireType.Bit64;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.FLOAT:
      return WireType.Bit32;
    default:
      return WireType.Varint;
  }
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
