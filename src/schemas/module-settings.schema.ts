import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Singleton-style settings collection. One document per `key`. Used for
 * runtime-editable module configuration (currently: hot pool overrides).
 *
 * Stored values supersede the corresponding section of config.yml on boot;
 * mutations from the API are written here so they survive restarts.
 */
@Schema({ timestamps: true, collection: 'module_settings' })
export class ModuleSettings {
  @Prop({ required: true, unique: true, index: true })
  key: string;

  @Prop({ type: Object, default: {} })
  value: Record<string, any>;
}

export type ModuleSettingsDocument = ModuleSettings & Document;
export const ModuleSettingsSchema = SchemaFactory.createForClass(ModuleSettings);

export const HOT_POOL_SETTINGS_KEY = 'hot_pool';
