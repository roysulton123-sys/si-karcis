package id.go.malangkab.dispora.sikarcis;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.File;
import java.io.FileOutputStream;

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private WebView webView;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private AlertDialog exitDialog;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#0F172A"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0F172A"));
        rootLayout.addView(
                webView,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                )
        );
        setContentView(rootLayout);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + " SIKarcisAndroid/1.1");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                Uri url = request.getUrl();
                String host = url.getHost() != null ? url.getHost() : "";
                if ("appassets.androidplatform.net".equalsIgnoreCase(host)) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, url);
                    startActivity(intent);
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        registerNetworkSyncCallback();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView == null) {
                    showExitConfirmationDialog();
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){ return (window.sikarcisHandleBackPress && window.sikarcisHandleBackPress()) ? 'handled' : 'exit'; })()",
                        result -> {
                            if (result != null && result.contains("handled")) {
                                return;
                            }
                            if (webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                showExitConfirmationDialog();
                            }
                        }
                );
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void registerNetworkSyncCallback() {
        try {
            connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivityManager == null) return;

            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();

            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    triggerWebViewCloudSync();
                }
            };
            connectivityManager.registerNetworkCallback(request, networkCallback);
        } catch (Exception ignored) {
        }
    }

    private void showExitConfirmationDialog() {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) {
                return;
            }
            if (exitDialog != null && exitDialog.isShowing()) {
                return;
            }
            exitDialog = new AlertDialog.Builder(this)
                    .setTitle("Keluar dari Aplikasi")
                    .setMessage("Apakah Anda ingin keluar dari aplikasi?")
                    .setCancelable(true)
                    .setNegativeButton("Batal", (dialog, which) -> dialog.dismiss())
                    .setPositiveButton("Ya, Keluar", (dialog, which) -> {
                        dialog.dismiss();
                        finishAffinity();
                    })
                    .create();
            exitDialog.show();
        });
    }

    private void triggerWebViewCloudSync() {
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('sikarcis-native-resume')); window.dispatchEvent(new CustomEvent('sikarcis-force-sync'));",
                        null
                );
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            triggerWebViewCloudSync();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        if (exitDialog != null && exitDialog.isShowing()) {
            exitDialog.dismiss();
        }
        try {
            if (connectivityManager != null && networkCallback != null) {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            }
        } catch (Exception ignored) {
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    public class AndroidBridge {

        @JavascriptInterface
        public boolean isAndroidApp() {
            return true;
        }

        @JavascriptInterface
        public void confirmExitApp() {
            showExitConfirmationDialog();
        }

        @JavascriptInterface
        public void triggerCloudSync() {
            triggerWebViewCloudSync();
        }

        @JavascriptInterface
        public void printPage(final String jobName) {
            runOnUiThread(() -> {
                try {
                    PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    if (printManager != null && webView != null) {
                        String safeName = (jobName != null && !jobName.isEmpty()) ? jobName : "Laporan_SI_KARCIS";
                        PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(safeName);
                        printManager.print(safeName, adapter, new PrintAttributes.Builder().build());
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Gagal membuka dialog cetak: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void saveBase64File(final String fileName, final String base64Data, final String mimeType) {
            runOnUiThread(() -> {
                try {
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) {
                        dir = getCacheDir();
                    }
                    if (!dir.exists()) {
                        dir.mkdirs();
                    }
                    String safeFileName = (fileName != null && !fileName.isEmpty()) ? fileName : "Laporan_SI_KARCIS.xlsx";
                    File outFile = new File(dir, safeFileName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                        fos.flush();
                    }

                    Uri fileUri = FileProvider.getUriForFile(
                            MainActivity.this,
                            getApplicationContext().getPackageName() + ".fileprovider",
                            outFile
                    );

                    Intent shareIntent = new Intent(Intent.ACTION_SEND);
                    shareIntent.setType(mimeType != null ? mimeType : "application/octet-stream");
                    shareIntent.putExtra(Intent.EXTRA_STREAM, fileUri);
                    shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(shareIntent, "Simpan / Bagikan " + safeFileName));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Gagal mengekspor file: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
