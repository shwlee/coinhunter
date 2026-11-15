/**
 * Engine-facing runner contract v1. This module supplies types only; it neither
 * registers languages nor replaces the existing PlayerProcess implementation.
 * @typedef {'javascript'|'csharp'|'cpp'|'python'} AlgorithmLanguage
 * @typedef {'created'|'initializing'|'ready'|'computing'|'closing'|'closed'|'failed'} RunnerState
 * @typedef {{sourceKey:string, sha256:string, byteLength:number}} SourceReference
 * @typedef {{artifactKey:string, sha256:string, byteLength:number}} ArtifactContent
 * @typedef {{name:string, version:string}} VersionIdentity
 * @typedef {{contractVersion:1, artifactId:string, language:AlgorithmLanguage,
 * source:SourceReference, content:ArtifactContent, format:string, profileId:string,
 * toolchain:VersionIdentity, runtime:VersionIdentity, adapterVersion:string,
 * target:{os:string, architecture:string}, optionsHash:string}} PreparedArtifact
 * @typedef {{contractVersion:1, requestId:string, language:AlgorithmLanguage,
 * source:SourceReference, profileId:string}} PreparationRequest
 * @typedef {{contractVersion:1, gameId:string, playerId:number, runId:string,
 * language:AlgorithmLanguage, artifact:PreparedArtifact,
 * limits:{turnMs:500, algorithmMemoryBytes:number|null}} RunnerContext
 * @typedef {{playerNumber:number, columns:number, rows:number}} InitializationInput
 * @typedef {{contractVersion:1, gameId:string, playerId:number, runId:string,
 * instanceId:string, hostId:string, language:AlgorithmLanguage, name:string,
 * runtime:VersionIdentity, adapterVersion:string}} RunnerInfo
 * @typedef {{contractVersion:1, gameId:string, playerId:number, runId:string,
 * callId:number, map:number[], myPosition:number, items:number[]}} MoveRequest
 * @typedef {{executionMs:number, executionBoundary:string, roundTripMs:number|null,
 * inputPreparationMs:number|null, responseProcessingMs:number|null,
 * engineApplyDelayMs:number|null}} CallTimings
 * @typedef {{contractVersion:1, gameId:string, playerId:number, runId:string,
 * instanceId:string, callId:number, status:'ok'|'timeout'|'exception'|'invalid-result',
 * direction:number, completion:'returned'|'interrupted', logs:string[],
 * droppedLogs:number, timings:CallTimings}} MoveResult
 * @typedef {{contractVersion:1, runId:string, resourcesReleased:true}} CloseReceipt
 * @typedef {{initialize(input:InitializationInput):Promise<RunnerInfo>,
 * move(request:MoveRequest):Promise<MoveResult>, close(reason?:string):Promise<CloseReceipt>}} AlgorithmRunner
 * @typedef {(context:RunnerContext)=>AlgorithmRunner} RunnerFactory
 * @typedef {{prepare(request:PreparationRequest, options?:{signal?:AbortSignal}):Promise<PreparedArtifact>}} AlgorithmPreparer
 */

export {};
