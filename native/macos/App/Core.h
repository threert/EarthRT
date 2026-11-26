// The globe view: the Rust static library in native/core (native/core/src/lib.rs documents each call and the
// messages ert_poll returns). Keep in step with its C ABI.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct ErtView ErtView;

ErtView *ert_create(void *metal_layer, uint32_t width, uint32_t height, float scale, const char *bundle, const char *root, const char *presets, const char *options);
void ert_resize(ErtView *view, uint32_t width, uint32_t height, float scale);
void ert_pointer(ErtView *view, float u, float v);
void ert_button(ErtView *view, uint8_t button, bool down);
void ert_wheel(ErtView *view, float notches);
void ert_key(ErtView *view, const char *code, const char *name, bool down);
void ert_send(ErtView *view, const char *json);
char *ert_poll(ErtView *view);
void ert_free(char *text);
void ert_snapshot(ErtView *view, const char *path);
void ert_reload(ErtView *view, const char *bundle);
void ert_rendering(ErtView *view, const char *json);
void ert_destroy(ErtView *view);
