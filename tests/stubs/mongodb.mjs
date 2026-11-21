// Offline stub so the simulation runs without `npm install` / network. Never connects anywhere.
export class MongoClient { constructor() {} async connect() { throw new Error('stub: no DB in simulation'); } }
export class ObjectId { constructor(v) { if (!/^[0-9a-fA-F]{24}$/.test(String(v))) throw new Error('bad id'); this.v = String(v).toLowerCase(); } toHexString() { return this.v; } }
