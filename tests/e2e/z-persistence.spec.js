/**
 * Persistence Tests — Data survives app restart.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, cleanup, createTestUserData, seedTestData } = require('../helpers/electron-app');

let userDataDir;

test.beforeAll(() => {
  userDataDir = createTestUserData();
  seedTestData(userDataDir);
});

test.afterAll(() => {
  cleanup(userDataDir);
});

test('Data persists across app restart', async () => {
  // First launch — verify data exists
  let result = await launchApp({ userDataDir });
  let orderCount = await result.window.evaluate(async () => {
    return (await window.api.getOrders()).length;
  });
  expect(orderCount).toBe(15);

  let invCount = await result.window.evaluate(async () => {
    return (await window.api.getInventory()).length;
  });
  expect(invCount).toBe(3);

  // Add an order via IPC to modify state
  await result.window.evaluate(async () => {
    // Use the save mechanism — just modify inventory to create state change
    await window.api.addInventoryItem({
      id: 'inv-persist-test',
      name: 'Persistence Test Item',
      setName: 'Test',
      sku: 'PERSIST-001',
      qty: 1,
      costPerUnit: 10,
      marketPrice: 20,
      addedAt: new Date().toISOString(),
      image: '',
      type: 'sealed',
      tcgPlayerUrl: ''
    });
  });

  // Close the app
  await result.app.close();

  // Second launch — verify data persisted (NO re-seeding)
  const result2 = await launchApp({ userDataDir, noSeed: true });
  const persistedInvCount = await result2.window.evaluate(async () => {
    return (await window.api.getInventory()).length;
  });
  // Should be 3 original + 1 new = 4
  expect(persistedInvCount).toBe(4);

  const persistedItem = await result2.window.evaluate(async () => {
    const inv = await window.api.getInventory();
    return inv.find(i => i.id === 'inv-persist-test');
  });
  expect(persistedItem).toBeTruthy();
  expect(persistedItem.name).toBe('Persistence Test Item');

  await result2.app.close();
});
