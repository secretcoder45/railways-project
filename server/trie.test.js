import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Trie } from "./trie.js";

describe("Trie", () => {
  it("returns empty array when trie is empty", () => {
    const t = new Trie();
    assert.deepEqual(t.search("raj"), []);
  });

  it("finds an exact prefix match", () => {
    const t = new Trie();
    const r = { train_no: "12301", train_name: "RAJDHANI EXPRESS" };
    t.insert("RAJDHANI EXPRESS", r);
    const hits = t.search("raj");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].train_no, "12301");
  });

  it("returns empty for a non-matching prefix", () => {
    const t = new Trie();
    t.insert("RAJDHANI", { train_no: "12301" });
    assert.deepEqual(t.search("sha"), []);
  });

  it("is case-insensitive for both insert and search", () => {
    const t = new Trie();
    t.insert("RAJDHANI", { train_no: "12301" });
    assert.equal(t.search("RAJ").length, 1);
    assert.equal(t.search("raj").length, 1);
    assert.equal(t.search("Raj").length, 1);
  });

  it("finds a train by number prefix", () => {
    const t = new Trie();
    t.insert("12301", { train_no: "12301" });
    assert.equal(t.search("123").length, 1);
  });

  it("respects the result limit parameter", () => {
    const t = new Trie(10);
    for (let i = 0; i < 8; i++) t.insert("RAJDHANI", { train_no: String(i) });
    assert.equal(t.search("raj", 3).length, 3);
  });

  it("returns empty for empty prefix string", () => {
    const t = new Trie();
    t.insert("RAJDHANI", { train_no: "12301" });
    assert.deepEqual(t.search(""), []);
  });

  it("increments nodeCount correctly", () => {
    const t = new Trie();
    t.insert("ABC", {});
    t.insert("ABD", {});
    // A→B are shared (2 nodes), then C and D branch (2 more) = 4 total
    assert.equal(t.nodeCount, 4);
  });
});
