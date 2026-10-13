// Starts the Comment button by itself when GroundworkFeedback is injected
// with DYLD_INSERT_LIBRARIES, so an app can use it without any change.
// Built by build-loader.sh, for the Simulator only.
//
// Loading the library alone does nothing: it also needs GROUNDWORK_FEEDBACK=1.

#import <TargetConditionals.h>
#include <stdlib.h>
#include <string.h>

// In Inject.swift.
extern void GroundworkFeedbackInject(void);

__attribute__((constructor)) static void GroundworkFeedbackLoad(void) {
#if TARGET_OS_SIMULATOR
  const char *on = getenv("GROUNDWORK_FEEDBACK");
  if (on && strcmp(on, "1") == 0) GroundworkFeedbackInject();
#endif
}
