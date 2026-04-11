import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

@Schema({ timestamps: true, collection: 'mcp_profiles' })
export class McpProfile {
  @ApiProperty()
  @Prop({ required: true })
  name: string;

  @ApiProperty()
  @Prop({ default: '' })
  description: string;

  @ApiProperty()
  @Prop({ type: [String], default: [] })
  allowedTools: string[];

  @ApiProperty()
  @Prop()
  defaultSandboxProfileId: string;

  @ApiProperty()
  @Prop({ default: false })
  readOnly: boolean;
}

export type McpProfileDocument = McpProfile & Document;
export const McpProfileSchema = SchemaFactory.createForClass(McpProfile);
