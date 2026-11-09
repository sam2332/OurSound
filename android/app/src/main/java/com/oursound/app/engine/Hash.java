package com.oursound.app.engine;

/**
 * Stateless seeded randomness, bit-exact with src/engine/hash.ts: the same
 * (seed, index) always gives the same number, so nothing random is stored.
 * Seeds are 32-bit ints (JS ToInt32 semantics); indices are whole numbers
 * held in doubles (exact up to 2^53).
 */
public final class Hash {
    private Hash() {}

    /** lowbias32 by Chris Wellons. */
    public static int mix32(int x) {
        x = (x ^ (x >>> 16)) * 0x7feb352d;
        x = (x ^ (x >>> 15)) * 0x846ca68b;
        return x ^ (x >>> 16);
    }

    private static double unsigned(int x) {
        return x & 0xffffffffL;
    }

    /** Uint32 hash (as int bits) of a seed and an integer index. */
    public static int hashIndex(int seed, double index) {
        long li = (long) index;
        int lo = (int) li;
        int hi = (int) Math.floorDiv(li, 4294967296L);
        return mix32(mix32(mix32(seed) ^ lo) ^ (hi * 0x9e3779b9));
    }

    /** Uniform in [0, 1). */
    public static double rand01(int seed, double index) {
        return unsigned(hashIndex(seed, index)) / 4294967296.0;
    }

    /** Uniform in [-1, 1). */
    public static double randSigned(int seed, double index) {
        return unsigned(hashIndex(seed, index)) / 2147483648.0 - 1;
    }

    public static int childSeed(int seed, double k) {
        return hashIndex(seed ^ 0x5bd1e995, k);
    }

    public static int seedMix(int seed) {
        return mix32(seed ^ 0x9e3779b9);
    }

    /** Fast per-sample noise in [-1, 1) for a pre-mixed seed. */
    public static double fastSigned(int seedMixed, double index) {
        long li = (long) index;
        int lo = (int) li;
        int hi = (int) Math.floorDiv(li, 4294967296L);
        return unsigned(mix32(seedMixed ^ lo ^ (hi * 0x85ebca6b))) / 2147483648.0 - 1;
    }

    /** Uniform in [0, 1) for a pre-mixed seed. */
    public static double fastUnit(int seedMixed, double index) {
        long li = (long) index;
        int lo = (int) li;
        int hi = (int) Math.floorDiv(li, 4294967296L);
        return unsigned(mix32(seedMixed ^ lo ^ (hi * 0x85ebca6b))) / 4294967296.0;
    }

    /** JS ToInt32 of a number that came from JSON (seeds can exceed 2^31). */
    public static int toInt32(double v) {
        return (int) (long) v;
    }
}
