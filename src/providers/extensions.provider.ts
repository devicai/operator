import { Schema } from 'mongoose';
import { ExtensionProperty } from '../config/config.types';

export const EXTENSIONS_TOKEN = Symbol('EXTENSIONS');

const TYPE_MAP: Record<string, unknown> = {
  string: String,
  number: Number,
  boolean: Boolean,
  date: Date,
};

export function applyExtensions(
  schema: Schema,
  entityName: string,
  extensions: ExtensionProperty[],
): void {
  for (const ext of extensions) {
    const applies =
      ext.entities === '*' ||
      (Array.isArray(ext.entities) && ext.entities.includes(entityName));

    if (!applies) continue;

    schema.add({
      [ext.name]: {
        type: TYPE_MAP[ext.type] ?? String,
        required: ext.required ?? false,
        index: ext.index ?? false,
      },
    });
  }
}
