// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { ImageHostProvider, ImageHostPlatform } from "@/stores/api-config-store";

const IMAGE_HOST_PRESETS: Array<Omit<ImageHostProvider, "id" | "apiKey">> = [
  {
    platform: "imgbb",
    name: "imgbb",
    baseUrl: "https://api.imgbb.com",
    uploadPath: "/1/upload",
    enabled: true,
    apiKeyParam: "key",
    expirationParam: "expiration",
    imageField: "image",
    nameField: "name",
    responseUrlField: "data.url",
    responseDeleteUrlField: "data.delete_url",
  },
  {
    platform: "custom",
    name: "自定义图床",
    baseUrl: "",
    uploadPath: "",
    enabled: true,
  },
  {
    platform: "cloudflare_r2",
    name: "Cloudflare R2",
    baseUrl: "",
    uploadPath: "",
    enabled: false,
  },
];

interface AddImageHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (provider: Omit<ImageHostProvider, "id">) => void;
}

export function AddImageHostDialog({
  open,
  onOpenChange,
  onSubmit,
}: AddImageHostDialogProps) {
  const [platform, setPlatform] = useState<ImageHostPlatform>("imgbb");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [uploadPath, setUploadPath] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [apiKeyParam, setApiKeyParam] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("");
  const [expirationParam, setExpirationParam] = useState("");
  const [imageField, setImageField] = useState("");
  const [nameField, setNameField] = useState("");
  const [responseUrlField, setResponseUrlField] = useState("");
  const [responseDeleteUrlField, setResponseDeleteUrlField] = useState("");

  const selectedPreset = IMAGE_HOST_PRESETS.find((p) => p.platform === platform);

  useEffect(() => {
    if (open) {
      const defaultPreset = IMAGE_HOST_PRESETS[0]; // imgbb
      setPlatform(defaultPreset.platform as ImageHostPlatform);
      setName(defaultPreset.name || "");
      setBaseUrl(defaultPreset.baseUrl || "");
      setUploadPath(defaultPreset.uploadPath || "");
      setApiKey("");
      setEnabled(defaultPreset.enabled ?? true);
      setApiKeyParam(defaultPreset.apiKeyParam || "");
      setApiKeyHeader(defaultPreset.apiKeyHeader || "");
      setExpirationParam(defaultPreset.expirationParam || "");
      setImageField(defaultPreset.imageField || "");
      setNameField(defaultPreset.nameField || "");
      setResponseUrlField(defaultPreset.responseUrlField || "");
      setResponseDeleteUrlField(defaultPreset.responseDeleteUrlField || "");
    }
  }, [open]);

  useEffect(() => {
    if (selectedPreset) {
      setName(selectedPreset.name || "");
      setBaseUrl(selectedPreset.baseUrl || "");
      setUploadPath(selectedPreset.uploadPath || "");
      setEnabled(selectedPreset.enabled ?? true);
      setApiKeyParam(selectedPreset.apiKeyParam || "");
      setApiKeyHeader(selectedPreset.apiKeyHeader || "");
      setExpirationParam(selectedPreset.expirationParam || "");
      setImageField(selectedPreset.imageField || "");
      setNameField(selectedPreset.nameField || "");
      setResponseUrlField(selectedPreset.responseUrlField || "");
      setResponseDeleteUrlField(selectedPreset.responseDeleteUrlField || "");
    }
  }, [selectedPreset]);

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error("请输入名称");
      return;
    }
    if (!baseUrl.trim() && !uploadPath.trim()) {
      toast.error("请配置 Base URL 或 Upload Path");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("请输入 API Key");
      return;
    }

    onSubmit({
      platform,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      uploadPath: uploadPath.trim(),
      apiKey: apiKey.trim(),
      enabled,
      apiKeyParam: apiKeyParam.trim() || undefined,
      apiKeyHeader: apiKeyHeader.trim() || undefined,
      expirationParam: expirationParam.trim() || undefined,
      imageField: imageField.trim() || undefined,
      nameField: nameField.trim() || undefined,
      responseUrlField: responseUrlField.trim() || undefined,
      responseDeleteUrlField: responseDeleteUrlField.trim() || undefined,
    });

    onOpenChange(false);
    toast.success(`已添加 ${name}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>添加图床服务商</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label>平台</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as ImageHostPlatform)}>
              <SelectTrigger>
                <SelectValue placeholder="选择平台" />
              </SelectTrigger>
              <SelectContent>
                {IMAGE_HOST_PRESETS.map((preset) => (
                  <SelectItem key={preset.platform} value={preset.platform}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="图床名称" />
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
          </div>

          <div className="space-y-2">
            <Label>Upload Path / URL</Label>
            <Input value={uploadPath} onChange={(e) => setUploadPath(e.target.value)} placeholder="/upload 或完整 URL" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>API Keys</Label>
            </div>
            <Textarea
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="输入 API Keys（每行一个，或用逗号分隔）"
              className="font-mono text-sm min-h-[80px]"
            />
          </div>

          <div className="flex items-center justify-between">
            <Label>启用</Label>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">高级配置（可选）</Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">API Key Query 参数</Label>
                <Input value={apiKeyParam} onChange={(e) => setApiKeyParam(e.target.value)} placeholder="key" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">API Key Header</Label>
                <Input value={apiKeyHeader} onChange={(e) => setApiKeyHeader(e.target.value)} placeholder="Authorization" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">过期参数</Label>
                <Input value={expirationParam} onChange={(e) => setExpirationParam(e.target.value)} placeholder="expiration" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">图片字段名</Label>
                <Input value={imageField} onChange={(e) => setImageField(e.target.value)} placeholder="image" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">名称字段名</Label>
                <Input value={nameField} onChange={(e) => setNameField(e.target.value)} placeholder="name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">返回 URL 字段</Label>
                <Input value={responseUrlField} onChange={(e) => setResponseUrlField(e.target.value)} placeholder="data.url" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">删除 URL 字段</Label>
                <Input value={responseDeleteUrlField} onChange={(e) => setResponseDeleteUrlField(e.target.value)} placeholder="data.delete_url" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit}>添加</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
