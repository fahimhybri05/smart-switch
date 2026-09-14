#pragma once

#include <stdbool.h>
#include <stddef.h>

// Extracts a non-negative integer from between prefix and suffix in uri.
// suffix == NULL means "must reach end of string" (trimmed at '?' if
// present). Returns false on malformed/missing input.
bool http_uri_parse_uint(const char *uri, const char *prefix, const char *suffix, long *out);

// Copies the remainder of uri after prefix into out (trimmed at '?' if
// present) for non-numeric path params like schedule ids. Returns false if
// uri doesn't start with prefix or the remainder doesn't fit in out_size.
bool http_uri_parse_str(const char *uri, const char *prefix, char *out, size_t out_size);
