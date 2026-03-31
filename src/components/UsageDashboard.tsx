import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { api, type UsageStats, type ProjectUsage, type FiveHourUsage } from "@/lib/api";
import { 
  ArrowLeft, 
  TrendingUp, 
  Calendar, 
  Filter,
  Loader2,
  DollarSign,
  Activity,
  FileText,
  Briefcase,
  Clock,
  RefreshCw
} from "lucide-react";
import { cn } from "@/lib/utils";

interface UsageDashboardProps {
  /**
   * Callback when back button is clicked
   */
  onBack: () => void;
}

/**
 * UsageDashboard component - Displays Claude API usage statistics and costs
 * 
 * @example
 * <UsageDashboard onBack={() => setView('welcome')} />
 */
export const UsageDashboard: React.FC<UsageDashboardProps> = ({ onBack }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [sessionStats, setSessionStats] = useState<ProjectUsage[] | null>(null);
  const [selectedDateRange, setSelectedDateRange] = useState<"all" | "5h" | "7d" | "30d">("all");
  const [activeTab, setActiveTab] = useState("overview");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fiveHourUsage, setFiveHourUsage] = useState<FiveHourUsage | null>(null);
  const [countdown, setCountdown] = useState<number>(0);

  // Auto-refresh interval in milliseconds (60 seconds default)
  const REFRESH_INTERVAL = 60000;
  // Estimated 5h usage limit in USD (Max $200 plan)
  const FIVE_HOUR_LIMIT = 80;

  const loadUsageStats = useCallback(async (isAutoRefresh = false) => {
    try {
      // Only show loading spinner on initial load, not on auto-refresh
      if (!isAutoRefresh) {
        setLoading(true);
      } else {
        setIsRefreshing(true);
      }
      setError(null);

      let statsData: UsageStats;
      let sessionData: ProjectUsage[];

      if (selectedDateRange === "all") {
        statsData = await api.getUsageStats();
        sessionData = await api.getSessionStats();
      } else {
        const endDate = new Date();
        const startDate = new Date();
        if (selectedDateRange === "5h") {
          startDate.setHours(startDate.getHours() - 5);
        } else {
          const days = selectedDateRange === "7d" ? 7 : 30;
          startDate.setDate(startDate.getDate() - days);
        }

        const formatDateForApi = (date: Date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        }

        statsData = await api.getUsageByDateRange(
          startDate.toISOString(),
          endDate.toISOString()
        );
        sessionData = await api.getSessionStats(
            formatDateForApi(startDate),
            formatDateForApi(endDate),
            'desc'
        );
      }

      setStats(statsData);
      setSessionStats(sessionData);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to load usage stats:", err);
      setError("Failed to load usage statistics. Please try again.");
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [selectedDateRange]);

  useEffect(() => {
    loadUsageStats();
  }, [loadUsageStats]);

  // Auto-refresh effect
  useEffect(() => {
    const interval = setInterval(() => {
      loadUsageStats(true); // true indicates it's an auto-refresh
    }, REFRESH_INTERVAL);

    // Cleanup interval on unmount
    return () => clearInterval(interval);
  }, [loadUsageStats]);

  // Load 5h usage data
  const load5hUsage = useCallback(async () => {
    try {
      const data = await api.get5hUsage();
      setFiveHourUsage(data);
      setCountdown(data.remaining_seconds);
    } catch (err) {
      console.error("Failed to load 5h usage:", err);
    }
  }, []);

  useEffect(() => {
    load5hUsage();
    const interval = setInterval(load5hUsage, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, [load5hUsage]);

  // Countdown timer - tick every second
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown > 0]);

  const formatCountdown = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(amount);
  };

  const formatNumber = (num: number): string => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  const formatTokens = (num: number): string => {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return formatNumber(num);
  };

  const getModelDisplayName = (model: string): string => {
    const modelLower = model.toLowerCase();

    // Check patterns in order of specificity (more specific first)
    // Opus models
    if (modelLower.includes("opus-4-5") || modelLower.includes("opus-4.5") ||
        modelLower.includes("claude-opus-4-5") || modelLower.includes("claude-opus-4.5")) {
      return "Opus 4.5";
    }
    if (modelLower.includes("opus-4-1") || modelLower.includes("opus-4.1") ||
        modelLower.includes("claude-opus-4-1") || modelLower.includes("claude-opus-4.1")) {
      return "Opus 4.1";
    }
    if (modelLower.includes("opus-4") || modelLower.includes("claude-opus-4")) {
      return "Opus 4";
    }
    if (modelLower.includes("opus-3") || modelLower.includes("claude-3-opus")) {
      return "Opus 3";
    }

    // Sonnet models
    if (modelLower.includes("sonnet-4-5") || modelLower.includes("sonnet-4.5") ||
        modelLower.includes("claude-sonnet-4-5") || modelLower.includes("claude-sonnet-4.5")) {
      return "Sonnet 4.5";
    }
    if (modelLower.includes("sonnet-4") || modelLower.includes("claude-sonnet-4")) {
      return "Sonnet 4";
    }
    if (modelLower.includes("sonnet-3-7") || modelLower.includes("sonnet-3.7") ||
        modelLower.includes("claude-3-7-sonnet") || modelLower.includes("claude-3.7-sonnet")) {
      return "Sonnet 3.7";
    }
    if (modelLower.includes("sonnet-3-5") || modelLower.includes("sonnet-3.5") ||
        modelLower.includes("claude-3-5-sonnet") || modelLower.includes("claude-3.5-sonnet")) {
      return "Sonnet 3.5";
    }

    // Haiku models
    if (modelLower.includes("haiku-4-5") || modelLower.includes("haiku-4.5") ||
        modelLower.includes("claude-haiku-4-5") || modelLower.includes("claude-haiku-4.5")) {
      return "Haiku 4.5";
    }
    if (modelLower.includes("haiku-3-5") || modelLower.includes("haiku-3.5") ||
        modelLower.includes("claude-3-5-haiku") || modelLower.includes("claude-3.5-haiku")) {
      return "Haiku 3.5";
    }
    if (modelLower.includes("haiku-3") || modelLower.includes("claude-3-haiku")) {
      return "Haiku 3";
    }

    return model;
  };

  const getModelColor = (model: string): string => {
    const modelLower = model.toLowerCase();
    if (modelLower.includes("opus")) return "text-purple-500";
    if (modelLower.includes("sonnet")) return "text-blue-500";
    if (modelLower.includes("haiku")) return "text-green-500";
    return "text-gray-500";
  };

  const formatLastRefresh = (date: Date | null): string => {
    if (!date) return "Never";
    
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    
    if (diffSecs < 60) return "Just now";
    if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
    if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
    return date.toLocaleTimeString();
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center space-x-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="h-8 w-8"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold">Usage Dashboard</h1>
              <p className="text-xs text-muted-foreground">
                Track your Claude Code usage and costs
              </p>
            </div>
          </div>
          
          {/* Refresh Indicator */}
          <div className="flex items-center space-x-4">
            {lastRefresh && (
              <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Updated {formatLastRefresh(lastRefresh)}</span>
              </div>
            )}
            
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { loadUsageStats(false); load5hUsage(); }}
              disabled={isRefreshing}
              className="h-8 w-8"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </Button>
          </div>
          
          {/* Date Range Filter */}
          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <div className="flex space-x-1">
              {(["all", "30d", "7d", "5h"] as const).map((range) => (
                <Button
                  key={range}
                  variant={selectedDateRange === range ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setSelectedDateRange(range)}
                  className="text-xs"
                >
                  {range === "all" ? "All Time" : range === "5h" ? "Last 5 Hours" : range === "7d" ? "Last 7 Days" : "Last 30 Days"}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-4" />
              <p className="text-sm text-muted-foreground">Loading usage statistics...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <p className="text-sm text-destructive mb-4">{error}</p>
              <Button onClick={() => loadUsageStats(false)} size="sm">
                Try Again
              </Button>
            </div>
          </div>
        ) : stats ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="max-w-6xl mx-auto space-y-6"
          >
            {/* 5-Hour Usage Gauge */}
            {fiveHourUsage && (
              <Card className="p-5 border-2 border-primary/20 bg-gradient-to-r from-background to-muted/30">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center space-x-2">
                    <Activity className="h-5 w-5 text-primary" />
                    <h3 className="text-sm font-bold">5-Hour Usage Window</h3>
                  </div>
                  <div className="flex items-center space-x-4">
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">API Calls</p>
                      <p className="text-sm font-semibold">{fiveHourUsage.api_calls}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Tokens</p>
                      <p className="text-sm font-semibold">{formatTokens(fiveHourUsage.total_tokens)}</p>
                    </div>
                  </div>
                </div>

                {/* Gauge Bar */}
                <div className="space-y-2">
                  <div className="flex items-end justify-between">
                    <div>
                      <p className="text-3xl font-bold tracking-tight">
                        {formatCurrency(fiveHourUsage.total_cost)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        of ~{formatCurrency(FIVE_HOUR_LIMIT)} estimated limit
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-mono font-bold tabular-nums">
                        {formatCountdown(countdown)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fiveHourUsage.api_calls > 0 ? "until oldest drops off" : "full window available"}
                      </p>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="relative h-6 bg-muted rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-500 ease-out",
                        fiveHourUsage.total_cost / FIVE_HOUR_LIMIT < 0.5
                          ? "bg-gradient-to-r from-green-500 to-green-400"
                          : fiveHourUsage.total_cost / FIVE_HOUR_LIMIT < 0.8
                            ? "bg-gradient-to-r from-yellow-500 to-amber-400"
                            : "bg-gradient-to-r from-red-500 to-red-400"
                      )}
                      style={{
                        width: `${Math.min(100, (fiveHourUsage.total_cost / FIVE_HOUR_LIMIT) * 100)}%`,
                      }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-xs font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                        {Math.min(100, (fiveHourUsage.total_cost / FIVE_HOUR_LIMIT) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  {/* Token breakdown mini bar */}
                  <div className="flex items-center space-x-3 text-xs text-muted-foreground pt-1">
                    <span className="flex items-center space-x-1">
                      <span className="w-2 h-2 rounded-full bg-blue-500" />
                      <span>In: {formatTokens(fiveHourUsage.total_input_tokens)}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <span className="w-2 h-2 rounded-full bg-purple-500" />
                      <span>Out: {formatTokens(fiveHourUsage.total_output_tokens)}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <span className="w-2 h-2 rounded-full bg-amber-500" />
                      <span>Cache W: {formatTokens(fiveHourUsage.total_cache_creation_tokens)}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                      <span>Cache R: {formatTokens(fiveHourUsage.total_cache_read_tokens)}</span>
                    </span>
                  </div>
                </div>
              </Card>
            )}

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* Total Cost Card */}
              <Card className="p-4 shimmer-hover">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Total Cost</p>
                    <p className="text-2xl font-bold mt-1">
                      {formatCurrency(stats.total_cost)}
                    </p>
                  </div>
                  <DollarSign className="h-8 w-8 text-muted-foreground/20 rotating-symbol" />
                </div>
              </Card>

              {/* Total Sessions Card */}
              <Card className="p-4 shimmer-hover">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Total Sessions</p>
                    <p className="text-2xl font-bold mt-1">
                      {formatNumber(stats.total_sessions)}
                    </p>
                  </div>
                  <FileText className="h-8 w-8 text-muted-foreground/20 rotating-symbol" />
                </div>
              </Card>

              {/* Total Tokens Card */}
              <Card className="p-4 shimmer-hover">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Total Tokens</p>
                    <p className="text-2xl font-bold mt-1">
                      {formatTokens(stats.total_tokens)}
                    </p>
                  </div>
                  <Activity className="h-8 w-8 text-muted-foreground/20 rotating-symbol" />
                </div>
              </Card>

              {/* Average Cost per Session Card */}
              <Card className="p-4 shimmer-hover">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Cost/Session</p>
                    <p className="text-2xl font-bold mt-1">
                      {formatCurrency(
                        stats.total_sessions > 0 
                          ? stats.total_cost / stats.total_sessions 
                          : 0
                      )}
                    </p>
                  </div>
                  <TrendingUp className="h-8 w-8 text-muted-foreground/20 rotating-symbol" />
                </div>
              </Card>
            </div>

            {/* Tabs for different views */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="models">By Model</TabsTrigger>
                <TabsTrigger value="projects">By Project</TabsTrigger>
                <TabsTrigger value="sessions">By Session</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
              </TabsList>

              {/* Overview Tab */}
              <TabsContent value="overview" className="space-y-4">
                <Card className="p-6">
                  <h3 className="text-sm font-semibold mb-4">Token Breakdown</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Input Tokens</p>
                      <p className="text-lg font-semibold">{formatTokens(stats.total_input_tokens)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Output Tokens</p>
                      <p className="text-lg font-semibold">{formatTokens(stats.total_output_tokens)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Cache Write</p>
                      <p className="text-lg font-semibold">{formatTokens(stats.total_cache_creation_tokens)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Cache Read</p>
                      <p className="text-lg font-semibold">{formatTokens(stats.total_cache_read_tokens)}</p>
                    </div>
                  </div>
                </Card>

                {/* Quick Stats */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card className="p-6">
                    <h3 className="text-sm font-semibold mb-4">Most Used Models</h3>
                    <div className="space-y-3">
                      {stats.by_model.slice(0, 3).map((model) => (
                        <div key={model.model} className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <Badge variant="outline" className={cn("text-xs", getModelColor(model.model))}>
                              {getModelDisplayName(model.model)}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {model.session_count} sessions
                            </span>
                          </div>
                          <span className="text-sm font-medium">
                            {formatCurrency(model.total_cost)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card className="p-6">
                    <h3 className="text-sm font-semibold mb-4">Top Projects</h3>
                    <div className="space-y-3">
                      {stats.by_project.slice(0, 3).map((project) => (
                        <div key={project.project_path} className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium truncate max-w-[200px]" title={project.project_path}>
                              {project.project_path}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {project.session_count} sessions
                            </span>
                          </div>
                          <span className="text-sm font-medium">
                            {formatCurrency(project.total_cost)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </TabsContent>

              {/* Models Tab */}
              <TabsContent value="models">
                <Card className="p-6">
                  <h3 className="text-sm font-semibold mb-4">Usage by Model</h3>
                  <div className="space-y-4">
                    {stats.by_model.map((model) => (
                      <div key={model.model} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <Badge 
                              variant="outline" 
                              className={cn("text-xs", getModelColor(model.model))}
                            >
                              {getModelDisplayName(model.model)}
                            </Badge>
                            <span className="text-sm text-muted-foreground">
                              {model.session_count} sessions
                            </span>
                          </div>
                          <span className="text-sm font-semibold">
                            {formatCurrency(model.total_cost)}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-xs">
                          <div>
                            <span className="text-muted-foreground">Input: </span>
                            <span className="font-medium">{formatTokens(model.input_tokens)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Output: </span>
                            <span className="font-medium">{formatTokens(model.output_tokens)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Cache W: </span>
                            <span className="font-medium">{formatTokens(model.cache_creation_tokens)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Cache R: </span>
                            <span className="font-medium">{formatTokens(model.cache_read_tokens)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </TabsContent>

              {/* Projects Tab */}
              <TabsContent value="projects">
                <Card className="p-6">
                  <h3 className="text-sm font-semibold mb-4">Usage by Project</h3>
                  <div className="space-y-3">
                    {stats.by_project.map((project) => (
                      <div key={project.project_path} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                        <div className="flex flex-col truncate">
                          <span className="text-sm font-medium truncate" title={project.project_path}>
                            {project.project_path}
                          </span>
                          <div className="flex items-center space-x-3 mt-1">
                            <span className="text-xs text-muted-foreground">
                              {project.session_count} sessions
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatTokens(project.total_tokens)} tokens
                            </span>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold">{formatCurrency(project.total_cost)}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(project.session_count > 0 ? project.total_cost / project.session_count : 0)}/session
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </TabsContent>

              {/* Sessions Tab */}
              <TabsContent value="sessions">
                  <Card className="p-6">
                      <h3 className="text-sm font-semibold mb-4">Usage by Session</h3>
                      <div className="space-y-3">
                          {sessionStats?.map((session) => (
                              <div key={`${session.project_path}-${session.project_name}`} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                                  <div className="flex flex-col">
                                      <div className="flex items-center space-x-2">
                                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                                        <span className="text-xs font-mono text-muted-foreground truncate max-w-[200px]" title={session.project_path}>
                                            {session.project_path.split('/').slice(-2).join('/')}
                                        </span>
                                      </div>
                                      <span className="text-sm font-medium mt-1">
                                          {session.project_name}
                                      </span>
                                  </div>
                                  <div className="text-right">
                                      <p className="text-sm font-semibold">{formatCurrency(session.total_cost)}</p>
                                      <p className="text-xs text-muted-foreground">
                                          {new Date(session.last_used).toLocaleDateString()}
                                      </p>
                                  </div>
                              </div>
                          ))}
                      </div>
                  </Card>
              </TabsContent>

              {/* Timeline Tab */}
              <TabsContent value="timeline">
                <Card className="p-6">
                  <h3 className="text-sm font-semibold mb-6 flex items-center space-x-2">
                    <Calendar className="h-4 w-4" />
                    <span>Daily Usage</span>
                  </h3>
                  {stats.by_date.length > 0 ? (() => {
                    const maxCost = Math.max(...stats.by_date.map(d => d.total_cost), 0);
                    const halfMaxCost = maxCost / 2;

                    return (
                      <div className="relative pl-8 pr-4">
                        {/* Y-axis labels */}
                        <div className="absolute left-0 top-0 bottom-8 flex flex-col justify-between text-xs text-muted-foreground">
                          <span>{formatCurrency(maxCost)}</span>
                          <span>{formatCurrency(halfMaxCost)}</span>
                          <span>{formatCurrency(0)}</span>
                        </div>
                        
                        {/* Chart container */}
                        <div className="flex items-end space-x-2 h-64 border-l border-b border-border pl-4">
                          {stats.by_date.slice().reverse().map((day) => {
                            const heightPercent = maxCost > 0 ? (day.total_cost / maxCost) * 100 : 0;
                            const date = new Date(day.date.replace(/-/g, '/'));
                            const formattedDate = date.toLocaleDateString('en-US', {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric'
                            });
                            
                            return (
                              <div key={day.date} className="flex-1 h-full flex flex-col items-center justify-end group relative">
                                {/* Tooltip */}
                                <div className="absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
                                  <div className="bg-background border border-border rounded-lg shadow-lg p-3 whitespace-nowrap">
                                    <p className="text-sm font-semibold">{formattedDate}</p>
                                    <p className="text-sm text-muted-foreground mt-1">
                                      Cost: {formatCurrency(day.total_cost)}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {formatTokens(day.total_tokens)} tokens
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {day.models_used.length} model{day.models_used.length !== 1 ? 's' : ''}
                                    </p>
                                  </div>
                                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                                    <div className="border-4 border-transparent border-t-border"></div>
                                  </div>
                                </div>
                                
                                {/* Bar */}
                                <div 
                                  className="w-full bg-[#d97757] hover:opacity-80 transition-opacity rounded-t cursor-pointer"
                                  style={{ height: `${heightPercent}%` }}
                                />
                                
                                {/* X-axis label – absolutely positioned below the bar so it doesn't affect bar height */}
                                <div
                                  className="absolute left-1/2 top-full mt-1 -translate-x-1/2 text-xs text-muted-foreground -rotate-45 origin-top-left whitespace-nowrap pointer-events-none"
                                >
                                  {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        
                        {/* X-axis label */}
                        <div className="mt-8 text-center text-xs text-muted-foreground">
                          Daily Usage Over Time
                        </div>
                      </div>
                    )
                  })() : (
                    <div className="text-center py-8 text-sm text-muted-foreground">
                      No usage data available for the selected period
                    </div>
                  )}
                </Card>
              </TabsContent>
            </Tabs>
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}; 