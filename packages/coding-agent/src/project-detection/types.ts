export type ProjectFacetConfidence = "explicit" | "strong" | "weak";

export type ProjectFacetEvidenceKind = "rootMarker" | "fileGlob" | "dependency" | "config" | "binary";

export interface ProjectFacetEvidence {
	kind: ProjectFacetEvidenceKind;
	path?: string;
	value?: string;
}

export interface ProjectFacet {
	id: string;
	root: string;
	confidence: ProjectFacetConfidence;
	evidence: ProjectFacetEvidence[];
}

export interface ProjectDetectorDefinition {
	id: string;
	rootMarkers?: readonly string[];
	fileGlobs?: readonly string[];
}

export interface DetectProjectFacetsOptions {
	cwd: string;
	repoRoot?: string | null;
	detectors?: readonly ProjectDetectorDefinition[];
	includeFileGlobs?: boolean;
}
