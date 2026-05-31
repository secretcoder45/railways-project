/**
 * LRU Cache — doubly linked list + HashMap
 *
 * Both get() and put() run in O(1) time.
 * Sentinel head/tail nodes eliminate edge-case null checks.
 */
export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map(); // key → node
    // Sentinel nodes (never evicted, never returned)
    this.head = { key: null, val: null, prev: null, next: null };
    this.tail = { key: null, val: null, prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this._hits = 0;
    this._misses = 0;
  }

  get(key) {
    if (!this.map.has(key)) {
      this._misses++;
      return null;
    }
    const node = this.map.get(key);
    this._remove(node);
    this._insertFront(node);
    this._hits++;
    return node.val;
  }

  put(key, val) {
    if (this.map.has(key)) {
      this._remove(this.map.get(key));
    }
    const node = { key, val, prev: null, next: null };
    this._insertFront(node);
    this.map.set(key, node);
    if (this.map.size > this.capacity) {
      // Evict least-recently-used (node just before tail sentinel)
      const lru = this.tail.prev;
      this._remove(lru);
      this.map.delete(lru.key);
    }
  }

  get size() {
    return this.map.size;
  }

  stats() {
    const total = this._hits + this._misses;
    return {
      size: this.map.size,
      capacity: this.capacity,
      hits: this._hits,
      misses: this._misses,
      hit_rate_pct: total === 0 ? 0 : Math.round((this._hits / total) * 100),
    };
  }

  _remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _insertFront(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }
}
