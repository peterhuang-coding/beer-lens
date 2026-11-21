import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalMenuKnowledge } from '../lib/beer-agent/provider.ts';
import { TurnDeadlineError } from '../lib/beer-agent/turn-deadline.ts';

test('an already-aborted turn stops local menu knowledge before DB/catalog work', async () => {
  const controller = new AbortController();
  controller.abort(new TurnDeadlineError());

  await assert.rejects(
    runLocalMenuKnowledge(
      [{ beerName: 'Synthetic Beer', brewery: 'Synthetic Brewery', style: 'Lager', abv: 4.5, price: 45, serving: '300ml' }],
      { signal: controller.signal },
    ),
    (error: any) => error?.code === 'turn_deadline_exceeded',
  );
});
