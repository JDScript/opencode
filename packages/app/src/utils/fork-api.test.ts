/** FORK-ONLY FILE — not present upstream, so it never conflicts on rebase. */
import { describe, expect, test } from "bun:test"
import { ForkApiError, createForkApi, isForkUnsupported, localDayOrigin, type UsageParams } from "./fork-api"

const at = (iso: string) => new Date(iso).getTime()
const localISO = (ms: number) => {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe("localDayOrigin", () => {
  test("lands on local midnight, whatever the time of day", () => {
    expect(localISO(localDayOrigin(at("2026-08-10T13:45:12")))).toBe("2026-08-10T00:00")
    expect(localISO(localDayOrigin(at("2026-08-10T00:00:00")))).toBe("2026-08-10T00:00")
    expect(localISO(localDayOrigin(at("2026-08-10T23:59:59")))).toBe("2026-08-10T00:00")
  })

  test("a shifted boundary keeps the small hours on the previous day", () => {
    // The reason the option exists: work at 02:00 belongs to the night that began the evening before,
    // and a calendar day would split one session across two columns.
    expect(localISO(localDayOrigin(at("2026-08-10T02:00:00"), 4))).toBe("2026-08-09T04:00")
    expect(localISO(localDayOrigin(at("2026-08-10T03:59:59"), 4))).toBe("2026-08-09T04:00")
    expect(localISO(localDayOrigin(at("2026-08-10T04:00:00"), 4))).toBe("2026-08-10T04:00")
    expect(localISO(localDayOrigin(at("2026-08-10T22:00:00"), 4))).toBe("2026-08-10T04:00")
  })

  test("stepping back a day never lands mid-day across a DST transition", () => {
    // `setDate(-1)` walks the calendar rather than subtracting 86400000, so a 23- or 25-hour day still
    // produces a boundary exactly at the requested hour. Subtracting a fixed day would drift by one.
    for (const iso of ["2026-03-08T02:30:00", "2026-11-01T02:30:00"]) {
      const origin = new Date(localDayOrigin(at(iso), 4))
      expect(origin.getHours()).toBe(4)
      expect(origin.getMinutes()).toBe(0)
    }
  })
})

describe("usage query", () => {
  const captured: string[] = []
  const fetchStub = async (input: RequestInfo | URL) => {
    captured.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    return new Response(JSON.stringify({ rows: [], groupBy: [], originMs: 0, truncated: false }), {
      headers: { "content-type": "application/json" },
    })
  }
  const api = createForkApi({ server: { url: "http://example.test/" }, fetch: fetchStub })

  const query = async (params: UsageParams) => {
    captured.length = 0
    await api.usage(params)
    return new URL(captured[0]).search
  }

  test("omits everything absent rather than sending empty values", async () => {
    expect(await query({})).toBe("")
  })

  test("joins dimensions with commas and flattens the child flag", async () => {
    expect(await query({ groupBy: ["time", "model"], bucketMs: 3600000 })).toBe(
      "?bucketMs=3600000&groupBy=time%2Cmodel",
    )
    expect(await query({ sessionID: "ses_1", includeChildren: true })).toBe("?sessionID=ses_1&includeChildren=true")
    // False must not be sent as the string "false", which the server would read as truthy presence.
    expect(await query({ sessionID: "ses_1", includeChildren: false })).toBe("?sessionID=ses_1")
  })

  test("keeps a zero origin, which is a meaningful value and not an absent one", async () => {
    expect(await query({ originMs: 0, bucketMs: 3600000 })).toBe("?bucketMs=3600000&originMs=0")
  })
})

describe("responses from a server without the fork's routes", () => {
  const respond = (body: string, init: ResponseInit) =>
    createForkApi({
      server: { url: "http://example.test" },
      fetch: async () => new Response(body, init),
    })

  const SPA = '<!doctype html><html lang="en"></html>'

  /** Asserts the rejection is a `ForkApiError` and narrows to its kind, so no cast is needed below. */
  const failureKind = async (call: () => Promise<unknown>) => {
    const error = await call().then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ForkApiError)
    return error instanceof ForkApiError ? error.kind : undefined
  }

  test("HTML served with 200 reads as unsupported, not as a JSON parse error", async () => {
    // This is the real shape, verified against both an official 1.18.15 install and a source run older
    // than the endpoint: `server/shared/ui.ts` has a `router.add("*", "/*")` catch-all that serves the SPA
    // for anything unrouted, so a missing endpoint answers 200 text/html. Reaching `response.json()` with
    // that body is where `SyntaxError: Unexpected token '<'` came from.
    const api = respond(SPA, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } })
    for (const call of [() => api.usage(), () => api.read(), () => api.schema(), () => api.validate("")]) {
      const error = await call().then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(isForkUnsupported(error)).toBe(true)
      expect(error).not.toBeInstanceOf(SyntaxError)
    }
  })

  test("404 also reads as unsupported", async () => {
    const api = respond("not found", { status: 404, headers: { "content-type": "text/plain" } })
    const error = await api.usage().catch((thrown: unknown) => thrown)
    expect(isForkUnsupported(error)).toBe(true)
  })

  test("401 stays distinct, so a locked server is not mistaken for an old one", async () => {
    const api = respond("", { status: 401 })
    expect(await failureKind(() => api.usage())).toBe("unauthorized")
  })

  test("a server error stays an error rather than becoming a missing feature", async () => {
    const api = respond('{"error":"boom"}', { status: 500, headers: { "content-type": "application/json" } })
    expect(await failureKind(() => api.usage())).toBe("http")
  })

  test("JSON that will not parse is a failure of the endpoint, not its absence", async () => {
    const api = respond("{ oops", { status: 200, headers: { "content-type": "application/json" } })
    expect(await failureKind(() => api.usage())).toBe("http")
  })

  test("a real JSON response still comes through", async () => {
    const api = respond('{"rows":[],"groupBy":[],"originMs":0,"truncated":false}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    expect((await api.usage()).rows).toEqual([])
  })
})
