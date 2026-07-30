#import <Capacitor/Capacitor.h>

CAP_PLUGIN(ScreenshotPlugin, "Screenshot",
    CAP_PLUGIN_METHOD(take, CAPPluginReturnPromise);
)
