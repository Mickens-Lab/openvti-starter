// Type URIs for the rooms/* Trust Tasks this client sends, at the versions this kit's pins serve
// (docs/VTC-SURFACE.md for the VTC, the VTA source at the pin for rooms/keys/*).
//  - rooms/{info,records,blobs,create}/* go to the room's host (a VTC or a standalone room-host).
//  - rooms/keys/* go to the member's own VTA, which holds the MLS group and the room credentials.
import { TT } from "@buildathon/vta-client";

export const ROOMS_TASK = {
  create: `${TT}/rooms/create/0.2`,
  info: `${TT}/rooms/info/0.3`,
  recordsPut: `${TT}/rooms/records/put/0.3`,
  recordsList: `${TT}/rooms/records/list/0.5`,
  recordsGet: `${TT}/rooms/records/get/0.2`,
  // Not in the pinned VTC's served matrix; used for retract/pin. [unverified] against a live host.
  recordsCurate: `${TT}/rooms/records/curate/0.1`,
  blobsUploadBegin: `${TT}/rooms/blobs/upload/begin/0.2`,
  blobsUploadChunk: `${TT}/rooms/blobs/upload/chunk/0.2`,
  blobsUploadCommit: `${TT}/rooms/blobs/upload/commit/0.2`,
  blobsUploadAbort: `${TT}/rooms/blobs/upload/abort/0.2`,
  blobsGet: `${TT}/rooms/blobs/get/0.2`,
  blobsChunk: `${TT}/rooms/blobs/chunk/0.1`,
} as const;

export const KEYS_TASK = {
  present: `${TT}/rooms/keys/present/0.2`,
  presentV01: `${TT}/rooms/keys/present/0.1`,
  seal: `${TT}/rooms/keys/seal/0.2`,
  sealV01: `${TT}/rooms/keys/seal/0.1`,
  open: `${TT}/rooms/keys/open/0.2`,
  openV01: `${TT}/rooms/keys/open/0.1`,
  keyPackage: `${TT}/rooms/keys/key-package/0.2`,
  welcome: `${TT}/rooms/keys/welcome/0.1`,
} as const;

/** The largest page `rooms/records/list` returns (vti-rooms storage.rs). */
export const LIST_PAGE_CAP = 500;
/** The MLS exporter label for the record storage key (vti-rooms mls.rs). Empty context, 32 bytes. */
export const STORAGE_EXPORTER_LABEL = "openvtc/room/storage/v1";
/** The suite every room group runs on (vti-rooms mls.rs). */
export const MLS_SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
/** Blob chunk size bounds (data-rooms-files.md): 16 KiB to 256 KiB. */
export const CHUNK_MIN = 16 * 1024;
export const CHUNK_MAX = 256 * 1024;
