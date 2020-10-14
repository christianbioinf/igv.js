/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014-2015 Broad Institute
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import FeatureFileReader from "./featureFileReader.js";
import FeatureCache from "./featureCache.js";
import CustomServiceReader from "./customServiceReader.js";
import UCSCServiceReader from "./ucscServiceReader.js";
import GFFHelper from "./gffHelper.js";
import GtexReader from "../gtex/gtexReader.js";
import ImmVarReader from "../gtex/immvarReader.js";
import TrackBase from "../trackBase.js";
import Ga4ghVariantReader from "../ga4gh/ga4ghVariantReader.js";
import CivicReader from "../civic/civicReader.js";
import GenomicInterval from "../genome/genomicInterval.js";
import pack from "../feature/featurePacker.js";


/**
 * feature source for "bed like" files (tab or whitespace delimited files with 1 feature per line: bed, gff, vcf, etc)
 *
 * @param config
 * @constructor
 */
class TextFeatureSource {

    constructor(config, genome) {

        this.config = config || {};
        this.genome = genome;
        this.sourceType = (config.sourceType === undefined ? "file" : config.sourceType);
        this.visibilityWindow = config.visibilityWindow;

        const queryableFormats = new Set(["bigwig", "bw", "bigbed", "bb", "tdf"]);

        // Default GFF filter -- these feature types will be filtered out
        if (undefined === config.filterTypes) {
            config.filterTypes = ['chromosome']
        }

        if (config.features && Array.isArray(config.features)) {
            let features = fixFeatures(config.features);
            packFeatures(features);
            if (config.mappings) {
                mapProperties(features, config.mappings)
            }
            this.featureCache = new FeatureCache(features, genome);
            this.static = true;
        } else if (config.reader) {
            this.reader = config.reader;
            this.queryable = config.queryable !== undefined ? config.queryable : true;
            this.expandQuery = config.expandQuery ? true : false;
        } else if (config.sourceType === "ga4gh") {
            this.reader = new Ga4ghVariantReader(config, genome);
            this.queryable = true;
        } else if (config.sourceType === "immvar") {
            this.reader = new ImmVarReader(config);
            this.queryable = true;
        } else if (config.type === "eqtl" && config.sourceType === "gtex-ws") {
            this.reader = new GtexReader(config);
            this.queryable = true;
            this.expandQuery = config.expandQuery ? true : false;
        } else if (config.sourceType === 'ucscservice') {
            this.reader = new UCSCServiceReader(config.source);
            this.queryable = true;
        } else if (config.sourceType === 'custom' || config.source !== undefined) {    // Second test for backward compatibility
            this.reader = new CustomServiceReader(config.source);
            this.queryable = config.source.queryable !== undefined ? config.source.queryable : true;
            this.expandQuery = config.expandQuery ? true : false;
        } else if ("civic-ws" === config.sourceType) {
            this.reader = new CivicReader(config);
            this.queryable = false;
            this.expandQuery = config.expandQuery ? true : false;
        } else {
            this.reader = new FeatureFileReader(config, genome);
            if (config.queryable !== undefined) {
                this.queryable = config.queryable
            } else if (queryableFormats.has(config.format)) {
                this.queryable = queryableFormats.has(config.format) || this.reader.indexed;
            } else {
                // Leav undefined -- will defer until we know if reader has an index
            }
        }
    }

    supportsWholeGenome() {
        return !this.queryable && (this.visibilityWindow === undefined || this.visibilityWindow <= 0);
    }

    async trackType() {
        const header = await this.getHeader();
        if (header) {
            return header.type;
        } else {
            return undefined;    // Convention for unknown or unspecified
        }
    }

    async getHeader() {
        if (!this.header) {

            if (this.reader && typeof this.reader.readHeader === "function") {
                const header = await this.reader.readHeader()
                if (header) {
                    this.header = header;
                    if (header.format) {
                        this.config.format = header.format;
                    }
                } else {
                    this.header = {};
                }
            } else {
                this.header = {};
            }
        }
        return this.header
    }

    /**
     * Required function for all data source objects.  Fetches features for the
     * range requested.
     *
     * @param chr
     * @param start
     * @param end
     * @param bpPerPixel
     */
    async getFeatures({chr, start, end, bpPerPixel, visibilityWindow}) {

        const reader = this.reader;
        const genome = this.genome;
        const queryChr = genome ? genome.getChromosomeName(chr) : chr;
        let intervalStart = start;
        let intervalEnd = end;
        let genomicInterval = new GenomicInterval(queryChr, intervalStart, intervalEnd);

        if (this.config.disableCache !== true &&
            this.featureCache &&
            (this.static || this.featureCache.containsRange(genomicInterval))) {
            return this.featureCache.queryFeatures(queryChr, start, end);
        } else {

            // Use visibility window to potentially expand query interval.
            // This can save re-queries as we zoom out.  Visibility window <= 0 is a special case
            // indicating whole chromosome should be read at once.
            if ((!visibilityWindow || visibilityWindow <= 0) && this.expandQuery !== false) {
                // Whole chromosome
                intervalStart = 0;
                intervalEnd = Number.MAX_SAFE_INTEGER;
            } else if (visibilityWindow > (end - start) && this.expandQuery !== false) {
                const expansionWindow = Math.min(4.1 * (end - start), visibilityWindow)
                intervalStart = Math.max(0, (start + end - expansionWindow) / 2);
                intervalEnd = start + expansionWindow;
            }
            genomicInterval = new GenomicInterval(queryChr, intervalStart, intervalEnd);

            let features = await reader.readFeatures(queryChr, genomicInterval.start, genomicInterval.end)
            if (this.queryable === undefined) {
                this.queryable = reader.indexed;
            }

            if (features) {
                this.ingestFeatures(features, genomicInterval);
            } else {
                this.featureCache = new FeatureCache([], genomicInterval);     // Empty cache
            }
        }

        const isQueryable = this.queryable;

        if ("all" === chr.toLowerCase()) {
            if (isQueryable) {   // queryable sources don't support whole genome view
                return [];
            } else {
                if (this.wgFeatures) {
                    return this.wgFeatures;
                } else {
                    this.wgFeatures = this.getWGFeatures(this.featureCache.getAllFeatures());
                    return this.wgFeatures;
                }
            }
        } else {
            return this.featureCache.queryFeatures(queryChr, start, end);
        }
    }

    ingestFeatures(featureList, genomicInterval) {

        if ("gtf" === this.config.format || "gff3" === this.config.format || "gff" === this.config.format) {
            featureList = (new GFFHelper(this.config)).combineFeatures(featureList);
        }

        // Assign overlapping features to rows
        if (this.config.format !== "wig" && this.config.type !== "junctions") {
            const maxRows = this.config.maxRows || Number.MAX_SAFE_INTEGER;
            packFeatures(featureList, maxRows);
        }

        // Note - replacing previous cache with new one.  genomicInterval is optional (might be undefined => includes all features)
        this.featureCache = new FeatureCache(featureList, this.genome, genomicInterval);

        // If track is marked "searchable"< cache features by name -- use this with caution, memory intensive
        if (this.config.searchable) {
            this.addFeaturesToDB(featureList);
        }
    }

    addFeaturesToDB(featureList) {
        for (let feature of featureList) {
            if (feature.name) {
                //TODO igv.browser => igv.Globals or igv.FeatureDB
                this.config.browser.featureDB[feature.name.toUpperCase()] = feature;
            }
            if (feature.gene && feature.gene.name) {
                this.config.browser.featureDB[feature.gene.name.toUpperCase()] = feature;
            }
        }
    }


// TODO -- filter by pixel size
    getWGFeatures(allFeatures) {

        const genome = this.genome;
        const wgChromosomeNames = new Set(genome.wgChromosomeNames);
        const wgFeatures = [];

        for (let c of genome.wgChromosomeNames) {

            const features = allFeatures[c];

            if (features) {
                for (let f of features) {
                    let queryChr = genome.getChromosomeName(f.chr);
                    if (wgChromosomeNames.has(queryChr)) {

                        const wg = Object.assign({}, f);

                        wg.chr = "all";
                        wg.start = genome.getGenomeCoordinate(f.chr, f.start);
                        wg.end = genome.getGenomeCoordinate(f.chr, f.end);
                        wg._f = f;

                        // Don't draw exons in whole genome view
                        if (wg["exons"]) delete wg["exons"]
                        wg.popupData = function (genomeLocation) {
                            if (typeof this._f.popupData === 'function') {
                                return this._f.popupData();
                            } else {
                                return TrackBase.extractPopupData(this._f, genome.id);
                            }
                        }

                        wgFeatures.push(wg);
                    }
                }
            }
        }

        wgFeatures.sort(function (a, b) {
            return a.start - b.start;
        });

        return wgFeatures;

    }
}

function packFeatures(features, maxRows) {

    maxRows = maxRows || 1000;
    if (features == null || features.length === 0) {
        return;
    }
    // Segregate by chromosome
    const chrFeatureMap = {};
    const chrs = [];
    for (let feature of features) {
        const chr = feature.chr;
        let flist = chrFeatureMap[chr];
        if (!flist) {
            flist = [];
            chrFeatureMap[chr] = flist;
            chrs.push(chr);
        }
        flist.push(feature);
    }

    // Loop through chrosomosomes and pack features;
    for (let chr of chrs) {
        pack(chrFeatureMap[chr], maxRows);
    }
}

/**
 * This function is used to apply properties normally added during parsing to  features supplied directly in the
 * config as an array of objects.   At the moment the only application is bedpe type features.
 * @param features
 */
function fixFeatures(features) {

    if (!features || features.length === 0) return;

    const isBedPE = features[0].chr === undefined && features[0].chr1 !== undefined;
    if (isBedPE) {
        const interChrFeatures = [];
        for (let feature of features) {
            // Set total extent of feature
            if (feature.chr1 === feature.chr2) {
                feature.chr = feature.chr1;
                feature.start = Math.min(feature.start1, feature.start2);
                feature.end = Math.max(feature.end1, feature.end2);
            } else {
                interChrFeatures.push(feature);
            }
        }
        // Make copies of inter-chr features, one for each chromosome
        for (let f1 of interChrFeatures) {
            const f2 = Object.assign({dup: true}, f1);
            features.push(f2);

            f1.chr = f1.chr1;
            f1.start = f1.start1;
            f1.end = f1.end1;

            f2.chr = f2.chr2;
            f2.start = f2.start2;
            f2.end = f2.end2;
        }
    }

    return features;
}


function mapProperties(features, mappings) {
    let mappingKeys = Object.keys(mappings);
    features.forEach(function (f) {
        mappingKeys.forEach(function (key) {
            f[key] = f[mappings[key]];
        });
    });
}


export default TextFeatureSource