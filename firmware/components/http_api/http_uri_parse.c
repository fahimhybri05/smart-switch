#include "http_uri_parse.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static size_t trim_at_query(const char *s)
{
    const char *q = strchr(s, '?');
    return q != NULL ? (size_t)(q - s) : strlen(s);
}

bool http_uri_parse_uint(const char *uri, const char *prefix, const char *suffix, long *out)
{
    size_t prefix_len = strlen(prefix);
    if (strncmp(uri, prefix, prefix_len) != 0) {
        return false;
    }

    const char *num_start = uri + prefix_len;
    char *end = NULL;
    long val = strtol(num_start, &end, 10);
    if (end == num_start || val < 0) {
        return false;
    }

    if (suffix != NULL) {
        if (strncmp(end, suffix, strlen(suffix)) != 0) {
            return false;
        }
        // whatever follows suffix must only be an optional query string
        const char *after = end + strlen(suffix);
        if (*after != '\0' && *after != '?') {
            return false;
        }
    } else {
        if (*end != '\0' && *end != '?') {
            return false; // trailing garbage that isn't a query string
        }
    }

    *out = val;
    return true;
}

bool http_uri_parse_str(const char *uri, const char *prefix, char *out, size_t out_size)
{
    size_t prefix_len = strlen(prefix);
    if (strncmp(uri, prefix, prefix_len) != 0) {
        return false;
    }

    const char *rest = uri + prefix_len;
    size_t len = trim_at_query(rest);
    if (len == 0 || len >= out_size) {
        return false;
    }

    memcpy(out, rest, len);
    out[len] = '\0';
    return true;
}
