import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./lru-cache.js";

describe("LRUCache", () => {
  it("returns null for missing keys", () => {
    const c = new LRUCache(3);
    assert.equal(c.get("x"), null);
  });

  it("stores and retrieves a value", () => {
    const c = new LRUCache(3);
    c.put("a", 42);
    assert.equal(c.get("a"), 42);
  });

  it("evicts the least-recently-used entry at capacity", () => {
    const c = new LRUCache(3);
    c.put("a", 1); c.put("b", 2); c.put("c", 3);
    c.put("d", 4); // "a" is LRU → evicted
    assert.equal(c.get("a"), null);
    assert.equal(c.get("d"), 4);
  });

  it("promotes accessed entry so it is not the next eviction target", () => {
    const c = new LRUCache(3);
    c.put("a", 1); c.put("b", 2); c.put("c", 3);
    c.get("a");    // "a" becomes MRU; "b" is now LRU
    c.put("d", 4); // "b" evicted, not "a"
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("b"), null);
  });

  it("size never exceeds capacity", () => {
    const c = new LRUCache(3);
    for (let i = 0; i < 100; i++) c.put(String(i), i);
    assert.equal(c.size, 3);
  });

  it("overwrites existing key without growing size", () => {
    const c = new LRUCache(3);
    c.put("a", 1); c.put("a", 99);
    assert.equal(c.get("a"), 99);
    assert.equal(c.size, 1);
  });

  it("tracks hits, misses, and hit rate correctly", () => {
    const c = new LRUCache(5);
    c.put("x", 10);
    c.get("x"); c.get("x"); c.get("missing");
    const s = c.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 1);
    assert.equal(s.hit_rate_pct, 67);
  });
});
