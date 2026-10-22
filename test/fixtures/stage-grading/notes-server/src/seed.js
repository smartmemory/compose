// Sample notes for a fresh database: `store.importNotes(SEED_NOTES)`.
// Rows come from older exports, so their tags carry whatever case the exporter used.

export const SEED_NOTES = [
  { title: 'Ferry schedule', body: 'Summer timetable, see attachment', tags: ['Travel', 'Boats'], createdAt: '2025-06-01T09:00:00.000Z' },
  { title: 'Packing list', body: 'Passport, charger, ferry tickets', tags: ['TRAVEL'], createdAt: '2025-06-02T09:00:00.000Z' },
  { title: 'Standup', body: 'Ship the booking fix on Friday', tags: ['Work'], createdAt: '2025-06-03T09:00:00.000Z' },
  { title: 'Recipes', body: 'Fish stew for the ferry crossing', tags: ['food', 'Travel'], createdAt: '2025-06-04T09:00:00.000Z' },
];
