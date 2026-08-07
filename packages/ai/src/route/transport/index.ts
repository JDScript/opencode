import type { Effect, Scope, Stream } from "effect"
import { Endpoint } from "../endpoint"
import { Auth } from "../auth"
import type { HttpMiddleware, Interface as RequestExecutorInterface } from "../executor"
import type { WebSocketChannelExecutor } from "./websocket-channel"
import type { AIError, LLMRequest } from "../../schema"

export interface TransportRuntime {
  readonly http: RequestExecutorInterface
}

export interface TransportExecution<Frame> {
  readonly frames: Stream.Stream<Frame, AIError>
  /** Optional successful-consumption acknowledgement. HTTP leaves this absent. */
  readonly complete?: Effect.Effect<void>
}

export interface TransportExecuteOptions {
  readonly webSocket?: WebSocketChannelExecutor
}

export interface Transport<Body, Prepared, Frame> {
  readonly id: string
  readonly prepare: (input: TransportPrepareInput<Body>) => Effect.Effect<Prepared, AIError>
  readonly execute: (
    prepared: Prepared,
    request: LLMRequest,
    runtime: TransportRuntime,
    options?: TransportExecuteOptions,
  ) => Effect.Effect<TransportExecution<Frame>, AIError, Scope.Scope>
}

export interface TransportPrepareInput<Body> {
  readonly body: Body
  readonly request: LLMRequest
  readonly endpoint: Endpoint.Definition<Body>
  readonly auth: Auth.Definition
  readonly encodeBody: (body: Body) => string
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  readonly middleware?: HttpMiddleware
  readonly webSocket?: WebSocketChannelExecutor
}

export * as HttpTransport from "./http"
export type { HttpHandler, HttpMiddleware } from "../executor"
export type {
  ChannelCheckpoint,
  ChannelCreate,
  ChannelObservation,
  WebSocketChannelDriver,
  WebSocketChannelExchange,
  WebSocketChannelExecution,
  WebSocketChannelExecutor,
} from "./websocket-channel"
export type { WebSocketConnection, WebSocketConnector, WebSocketRequest } from "./websocket"
export { WebSocketTransport } from "./websocket"
