import { BaseRepository } from './base.repository';
import { ExtensionScope } from '../interfaces';

// Minimal concrete subclass so we can instantiate the abstract base.
class TestRepository extends BaseRepository<any> {}

function makeRepository(findOneResult: unknown = null) {
  const exec = jest.fn().mockResolvedValue(findOneResult);
  const model: any = { findOne: jest.fn().mockReturnValue({ exec }) };
  // No extension properties -> applyScope is a no-op.
  const repo = new TestRepository(model, 'test', []);
  return { repo, model };
}

const NO_SCOPE: ExtensionScope = {};

describe('BaseRepository.findById', () => {
  it('returns null without touching the model when the id is not an ObjectId (nanoid)', async () => {
    // Regression: nanoids like these used to be cast to ObjectId, throwing a
    // Mongoose CastError -> HTTP 500 instead of a clean 404.
    const { repo, model } = makeRepository({ _id: 'should-not-be-returned' });
    await expect(repo.findById('p8vbL6AkFyLj', NO_SCOPE)).resolves.toBeNull(); // 12-char nanoid
    await expect(repo.findById('nonexistent-xyz', NO_SCOPE)).resolves.toBeNull(); // longer
    await expect(repo.findById('', NO_SCOPE)).resolves.toBeNull();
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('queries by _id for a canonical 24-hex ObjectId string', async () => {
    const doc = { _id: '64b7f9e2c1a2b3d4e5f60718' };
    const { repo, model } = makeRepository(doc);
    await expect(repo.findById('64b7f9e2c1a2b3d4e5f60718', NO_SCOPE)).resolves.toBe(doc);
    expect(model.findOne).toHaveBeenCalledWith({ _id: '64b7f9e2c1a2b3d4e5f60718' });
  });

  it('returns null (not an error) when a valid ObjectId simply has no match', async () => {
    const { repo } = makeRepository(null);
    await expect(repo.findById('64b7f9e2c1a2b3d4e5f60718', NO_SCOPE)).resolves.toBeNull();
  });
});
