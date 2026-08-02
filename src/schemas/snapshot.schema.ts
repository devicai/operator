import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export enum SnapshotStatus {
  CREATING = 'creating',
  READY = 'ready',
  RESTORING = 'restoring',
  FAILED = 'failed',
}

/**
 * Whether a capture is currently writing this snapshot. Orthogonal to `status`
 * because a snapshot being re-saved is still restorable: the previous artifact
 * stays on disk untouched until the new one is renamed over it.
 */
export enum SnapshotSaveState {
  IDLE = 'idle',
  SAVING = 'saving',
}

@Schema({ timestamps: true, collection: 'snapshots' })
export class Snapshot {
  @ApiProperty()
  @Prop({ required: true, unique: true, index: true })
  snapshotId: string;

  @ApiProperty()
  @Prop({ required: true, index: true })
  sandboxId: string;

  @ApiProperty()
  @Prop({ required: true })
  name: string;

  @ApiProperty()
  @Prop()
  description: string;

  @ApiProperty({ enum: SnapshotStatus })
  @Prop({ default: SnapshotStatus.CREATING, enum: SnapshotStatus })
  status: SnapshotStatus;

  @ApiProperty()
  @Prop({ required: true })
  image: string;

  @ApiProperty()
  @Prop({ required: true })
  workdir: string;

  @ApiProperty()
  @Prop({ default: 1 })
  cpus: number;

  @ApiProperty()
  @Prop({ default: 256 })
  memoryMib: number;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  envVars: Record<string, string>;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  ports: Record<string, number>;

  @ApiProperty({
    description:
      'HTTP port the source sandbox exposed through the public ingress; ' +
      'restores default to it.',
    required: false,
  })
  @Prop()
  exposedHttpPort?: number;

  // ---------------------------------------------------------------------------
  // Stable public identity
  //
  // A sandbox restored from this snapshot gets a fresh `sandboxId` every time,
  // so publishing it under that id gives a URL that changes on every session.
  // These two fields move the public identity from the sandbox to the snapshot,
  // which is what actually survives: the URL of a service published inside a
  // sandbox stays the same across restores, and it keeps working while nothing
  // is running (see the ingress proxy's dormant-sandbox path).
  // ---------------------------------------------------------------------------

  /**
   * Subdomain this snapshot is served under. Optional: when absent the ingress
   * derives one from `snapshotId`, so every snapshot has a stable URL without
   * anyone configuring anything. Unique (sparse) because the subdomain is the
   * routing key — two snapshots answering the same hostname would be a silent
   * hijack, and `toDnsLabel` lowercases a nanoid that is case-sensitive, so
   * collisions are reachable rather than theoretical.
   */
  @ApiProperty({
    description:
      'Subdomain serving this snapshot, e.g. "my-app" for my-app.sandbox.devic.ai. ' +
      'Defaults to a label derived from snapshotId when unset.',
    required: false,
  })
  @Prop({ index: true, unique: true, sparse: true })
  slug?: string;

  /**
   * Whether visiting this snapshot's URL while nothing is running restores it
   * automatically. Opt-out: absent means enabled, so the feature applies to
   * snapshots that predate it without a migration.
   */
  @ApiProperty({
    description:
      'Restore this snapshot automatically when its public URL is visited and ' +
      'no sandbox is serving it. Enabled unless explicitly set to false.',
    required: false,
  })
  @Prop()
  autoRestart?: boolean;

  @ApiProperty()
  @Prop({ required: true })
  snapshotPath: string;

  @ApiProperty({
    description:
      "What the tarball captures: 'full' (whole-filesystem diff vs base image) " +
      "or 'workdir' (working directory only). New snapshots set this explicitly " +
      "at create time; the default is 'workdir' so legacy documents that predate " +
      'this field hydrate as workdir-only (their tarball is a workdir archive) ' +
      'and restore correctly.',
  })
  @Prop({ default: 'workdir' })
  scope: string;

  @ApiProperty({
    description:
      "Compression codec of the tarball: 'zstd' or 'gzip'. Recorded at create " +
      'time so restore decompresses with the matching tool.',
  })
  @Prop({ default: 'gzip' })
  compression: string;

  @ApiProperty()
  @Prop({ default: 0 })
  sizeBytes: number;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;

  // ---------------------------------------------------------------------------
  // Image cache
  //
  // A snapshot's tarball is its artifact of record. These fields describe an
  // OPTIONAL derived copy of the same content, pre-materialized as a container
  // image so a restore is just "create a container" instead of "create a
  // container and replay a tarball into it" (~2s flat vs 15-65s scaling with
  // size). Every field here is disposable: delete the image and the next
  // restore falls back to the tarball, which is exactly today's behaviour.
  // ---------------------------------------------------------------------------

  /**
   * Bumped on every capture (create and each persist). The image records which
   * version it was built from, so a build that finishes after a newer capture
   * landed is discarded instead of publishing stale content.
   */
  @ApiProperty({
    description: 'Monotonic counter incremented on every capture of this snapshot.',
  })
  @Prop({ default: 0 })
  persistVersion: number;

  @ApiProperty({
    description:
      "State of the derived image: 'none' (never built), 'building', " +
      "'ready' (usable for restore), 'failed' (build errored; restores use the " +
      'tarball). Absent on documents that predate the image cache.',
    required: false,
  })
  @Prop({ index: true })
  imageState?: string;

  @ApiProperty({
    description: 'Image reference holding this snapshot, e.g. devic-snapshot:abc123.',
    required: false,
  })
  @Prop()
  imageRef?: string;

  /** `persistVersion` the current image was built from. */
  @ApiProperty({ required: false })
  @Prop()
  imageSourceVersion?: number;

  @ApiProperty({ required: false })
  @Prop()
  imageBuiltAt?: Date;

  /**
   * Bytes the image adds on top of layers it shares with its base. Drives the
   * cache cap and eviction; the shared base is not attributed here because it
   * is paid once for every sandbox on the host, image cache or not.
   */
  @ApiProperty({ required: false })
  @Prop({ default: 0 })
  imageSizeBytes?: number;

  /** Last time a restore was served from the image. Drives LRU eviction. */
  @ApiProperty({ required: false })
  @Prop({ index: true })
  imageLastUsedAt?: Date;

  @ApiProperty({
    enum: SnapshotSaveState,
    description:
      "'saving' while a capture is writing this snapshot. The status stays " +
      "READY throughout: the artifact on disk is the PREVIOUS capture and is " +
      'complete and restorable (captures write to a temp file and rename), so ' +
      'a caller that knowingly forces a restore gets the last saved version ' +
      'rather than a truncated tarball.',
  })
  @Prop({ default: SnapshotSaveState.IDLE, enum: SnapshotSaveState })
  saveState: SnapshotSaveState;

  @ApiProperty({ required: false, description: 'When the current save started.' })
  @Prop()
  savingSince?: Date;

  @ApiProperty({
    required: false,
    description: 'Sandbox whose filesystem the current save is capturing.',
  })
  @Prop()
  savingSandboxId?: string;
}

export type SnapshotDocument = Snapshot & Document;
export const SnapshotSchema = SchemaFactory.createForClass(Snapshot);
