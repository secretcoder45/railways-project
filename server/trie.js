/**
 * Prefix Trie for O(k) train name/number autocomplete.
 *
 * Each node stores up to `bucketSize` route references, populated during
 * insertion so search() never needs a DFS — it just returns the node's
 * pre-filled array in O(k) time where k = prefix length.
 *
 * Plain objects are used for children (vs Map) to reduce per-node memory
 * from ~200 bytes to ~80 bytes across the ~70k nodes the full corpus creates.
 */

class TrieNode {
  constructor() {
    this.c = {}; // children: char → TrieNode
    this.r = []; // route refs at this prefix, capped at bucketSize
  }
}

export class Trie {
  constructor(bucketSize = 20) {
    this.root = new TrieNode();
    this.bucketSize = bucketSize;
    this.nodeCount = 0;
  }

  /**
   * Insert `word` (train name or number) linked to `route`.
   * Capped at 20 characters — enough to disambiguate any Indian train name.
   */
  insert(word, route) {
    if (!word) return;
    let node = this.root;
    const normalized = word.toLowerCase().slice(0, 20);
    for (const ch of normalized) {
      if (!node.c[ch]) {
        node.c[ch] = new TrieNode();
        this.nodeCount++;
      }
      node = node.c[ch];
      if (node.r.length < this.bucketSize) node.r.push(route);
    }
  }

  /**
   * Return up to `limit` routes whose name/number has `prefix` as a prefix.
   * O(k) where k = prefix.length.
   */
  search(prefix, limit = 10) {
    if (!prefix) return [];
    let node = this.root;
    for (const ch of prefix.toLowerCase()) {
      if (!node.c[ch]) return [];
      node = node.c[ch];
    }
    return node.r.slice(0, limit);
  }
}
