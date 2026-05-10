import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export enum SandboxStatus {
  PENDING = 'pending',
  CREATING = 'creating',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

@Schema({ timestamps: true, collection: 'sandboxes' })
export class Sandbox {
  @ApiProperty()
  @Prop({ required: true, unique: true, index: true })
  sandboxId: string;

  @ApiProperty()
  @Prop({ required: true })
  name: string;

  @ApiProperty()
  @Prop()
  profileId: string;

  @ApiProperty({ enum: SandboxStatus })
  @Prop({ default: SandboxStatus.PENDING, enum: SandboxStatus, index: true })
  status: SandboxStatus;

  @ApiProperty()
  @Prop({ default: 'node:24' })
  image: string;

  @ApiProperty()
  @Prop({ default: '/workspace' })
  workdir: string;

  @ApiProperty()
  @Prop({ default: '/workspace' })
  currentCwd: string;

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

  @ApiProperty()
  @Prop({ default: 1800 })
  ttlSeconds: number;

  @ApiProperty()
  @Prop({ index: true })
  expiresAt: Date;

  @ApiProperty()
  @Prop()
  snapshotId: string;

  @ApiProperty()
  @Prop({ default: 0 })
  commandCount: number;

  @ApiProperty()
  @Prop({ type: [String], default: [] })
  recentCommands: string[];

  @ApiProperty()
  @Prop({ index: true, sparse: true })
  bindingId: string;

  @ApiProperty({
    description:
      'True while this sandbox is sitting in the hot pool, idle and waiting ' +
      'to be claimed. Cleared the moment the sandbox is handed out to a caller.',
  })
  @Prop({ default: false, index: true })
  hotReserved: boolean;

  @ApiProperty({
    description:
      'Port inside the sandbox that the ingress proxy forwards HTTP traffic ' +
      'to. Falls back to ingress.defaultUpstreamPort when not set.',
    required: false,
  })
  @Prop()
  exposedHttpPort?: number;

  @ApiProperty({
    description:
      'Subdomain assigned to the sandbox under ingress.wildcardDomain. ' +
      'Set only when ingress is enabled and the sandbox is published. ' +
      'Currently equals sandboxId; reserved as a separate field so future ' +
      'releases can assign a different label without changing sandboxId.',
    required: false,
  })
  @Prop({ index: true, sparse: true })
  subdomain?: string;

  @ApiProperty({
    description:
      'Public URL at which the sandbox is reachable while it is in the RUNNING ' +
      'state and ingress is enabled. Cleared on stop / destroy.',
    required: false,
  })
  @Prop()
  publicUrl?: string;

  @ApiProperty({
    description:
      'Internal endpoint (host:port) the proxy uses to reach this sandbox. ' +
      'Format depends on the runtime (Docker bridge IP, microsandbox host port).',
    required: false,
  })
  @Prop()
  internalEndpoint?: string;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;
}

export type SandboxDocument = Sandbox & Document;
export const SandboxSchema = SchemaFactory.createForClass(Sandbox);
