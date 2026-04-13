import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export enum SnapshotStatus {
  CREATING = 'creating',
  READY = 'ready',
  RESTORING = 'restoring',
  FAILED = 'failed',
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

  @ApiProperty()
  @Prop({ required: true })
  snapshotPath: string;

  @ApiProperty()
  @Prop({ default: 0 })
  sizeBytes: number;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;
}

export type SnapshotDocument = Snapshot & Document;
export const SnapshotSchema = SchemaFactory.createForClass(Snapshot);
