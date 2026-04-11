import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

@Schema({ timestamps: true, collection: 'sandbox_profiles' })
export class SandboxProfile {
  @ApiProperty()
  @Prop({ required: true })
  name: string;

  @ApiProperty()
  @Prop({ default: '' })
  description: string;

  @ApiProperty()
  @Prop({ default: 'node:24' })
  image: string;

  @ApiProperty()
  @Prop({ default: '/workspace' })
  workdir: string;

  @ApiProperty()
  @Prop({ default: 1, min: 1, max: 8 })
  cpus: number;

  @ApiProperty()
  @Prop({ default: 256, min: 256, max: 8192 })
  memoryMib: number;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  envVars: Record<string, string>;

  @ApiProperty()
  @Prop({ default: '' })
  initScript: string;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  ports: Record<string, number>;

  @ApiProperty()
  @Prop({ default: 1800 })
  ttlSeconds: number;

  @ApiProperty()
  @Prop({ default: 'allow-all' })
  networkPolicy: string;
}

export type SandboxProfileDocument = SandboxProfile & Document;
export const SandboxProfileSchema = SchemaFactory.createForClass(SandboxProfile);
