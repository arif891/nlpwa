/**
 * RFC 7233 / RFC 9110 Range request helper.
 *
 * Slices a cached 200 OK response to produce an HTTP 206 Partial Content response.
 * Safari on iOS and macOS requires Range request support for <audio> and <video> playback.
 *
 * @param {Request} request
 * @param {Response} response
 * @returns {Promise<Response>}
 */
export async function createRangeResponse(request, response) {
  if (!request?.headers || typeof request.headers.get !== 'function') {
    return response;
  }

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader || !response || response.status !== 200) {
    return response;
  }

  const match = rangeHeader.trim().match(/^bytes=\s*(\d*)\s*-\s*(\d*)$/i);
  if (!match) {
    return response;
  }

  let arrayBuffer;
  try {
    arrayBuffer = await response.clone().arrayBuffer();
  } catch {
    return response;
  }

  const totalLength = arrayBuffer.byteLength;
  const startStr = match[1];
  const endStr = match[2];

  let start;
  let end;

  if (!startStr && !endStr) {
    return response;
  }

  if (!startStr) {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffix = parseInt(endStr, 10);
    if (Number.isNaN(suffix) || suffix <= 0) {
      return new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: {
          'Content-Range': `bytes */${totalLength}`,
        },
      });
    }
    start = Math.max(0, totalLength - suffix);
    end = totalLength - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : totalLength - 1;
  }

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    start >= totalLength ||
    end < start
  ) {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: {
        'Content-Range': `bytes */${totalLength}`,
      },
    });
  }

  // Range ends are inclusive
  end = Math.min(end, totalLength - 1);
  const sliced = arrayBuffer.slice(start, end + 1);
  const contentLength = end - start + 1;

  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);
  headers.set('Content-Length', String(contentLength));
  headers.set('Accept-Ranges', 'bytes');

  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}
