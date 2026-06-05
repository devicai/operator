import { Model, FilterQuery, UpdateQuery } from 'mongoose';
import { Inject, Injectable } from '@nestjs/common';
import { ExtensionProperty } from '../config/config.types';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';

/**
 * Canonical string form of a Mongo ObjectId (24 hex chars). Our public ids are
 * nanoids, never ObjectIds, so anything that isn't 24-hex cannot match an `_id`.
 * We must not hand such a value to Mongoose: under mongoose 8 / bson 6 casting a
 * non-24-hex string to ObjectId throws a CastError, which surfaces as a 500
 * instead of the intended 404. (Note: `mongoose.isValidObjectId` is too lenient
 * here — it accepts any 12-char string — so we match the hex form explicitly.)
 */
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

@Injectable()
export abstract class BaseRepository<T> {
  constructor(
    protected readonly model: Model<T>,
    protected readonly entityName: string,
    @Inject(EXTENSIONS_TOKEN)
    private readonly extensions: ExtensionProperty[],
  ) {}

  protected applyScope(
    filter: FilterQuery<T>,
    scope: ExtensionScope,
  ): FilterQuery<T> {
    const scopedFilter = { ...filter };

    for (const ext of this.extensions) {
      const applies =
        ext.entities === '*' ||
        (Array.isArray(ext.entities) && ext.entities.includes(this.entityName));

      if (applies && scope[ext.name]) {
        (scopedFilter as Record<string, unknown>)[ext.name] = scope[ext.name];
      }
    }

    return scopedFilter;
  }

  async find(
    filter: FilterQuery<T>,
    scope: ExtensionScope,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ): Promise<PaginatedResponse<T>> {
    const scopedFilter = this.applyScope(filter, scope);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    const [data, total] = await Promise.all([
      this.model
        .find(scopedFilter)
        .sort(options?.sort ?? { createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.model.countDocuments(scopedFilter).exec(),
    ]);

    return {
      data: data as T[],
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  async findOne(filter: FilterQuery<T>, scope: ExtensionScope): Promise<T | null> {
    return this.model.findOne(this.applyScope(filter, scope)).exec() as Promise<T | null>;
  }

  async findById(id: string, scope: ExtensionScope): Promise<T | null> {
    // A nanoid (or any non-ObjectId string) can never match an `_id`; return
    // null rather than letting Mongoose throw a CastError. Callers that look up
    // by a public id first try `findOne({ <publicId>: id })` and fall back here,
    // so a non-existent id must resolve to "not found", not an error.
    if (!OBJECT_ID_RE.test(id)) return null;
    return this.findOne({ _id: id } as FilterQuery<T>, scope);
  }

  async create(data: Partial<T>, scope: ExtensionScope): Promise<T> {
    const enriched = { ...data, ...scope };
    const doc = await this.model.create(enriched);
    return doc as T;
  }

  async updateOne(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    scope: ExtensionScope,
  ): Promise<T | null> {
    return this.model
      .findOneAndUpdate(this.applyScope(filter, scope), update, { new: true })
      .exec() as Promise<T | null>;
  }

  async updateById(
    id: string,
    update: UpdateQuery<T>,
    scope: ExtensionScope,
  ): Promise<T | null> {
    return this.updateOne({ _id: id } as FilterQuery<T>, update, scope);
  }

  async deleteOne(filter: FilterQuery<T>, scope: ExtensionScope): Promise<boolean> {
    const result = await this.model.deleteOne(this.applyScope(filter, scope)).exec();
    return result.deletedCount > 0;
  }

  async deleteById(id: string, scope: ExtensionScope): Promise<boolean> {
    return this.deleteOne({ _id: id } as FilterQuery<T>, scope);
  }
}
